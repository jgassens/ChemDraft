// SPDX-License-Identifier: Apache-2.0
#include "reference-geometry.h"
#include "optimizer-observer.h"

#include <avogadro/calc/energyoptimizer.h>
#include <avogadro/calc/uff.h>
#include <Eigen/Geometry>
#include <Eigen/LU>
#include <Eigen/SVD>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <limits>
#include <optional>
#include <string>
#include <utility>

namespace Spin3dBenchmark {
AcceptedStepObserver acceptedStepObserver = nullptr;
namespace {
std::size_t lbfgsIterations = 0;
}
void recordLbfgsIterations(std::size_t iterations)
{
  lbfgsIterations = iterations;
}
} // namespace Spin3dBenchmark

namespace {
using Avogadro::Calc::OptimizationAlgorithm;
using Avogadro::Calc::OptimizationOptions;
using Avogadro::Calc::OptimizerState;
using Avogadro::Calc::UFF;
using Eigen::Vector3d;
using Spin3dReference::Geometry;
using Spin3dReference::Molecule;
using Spin3dReference::VectorXd;
using Spin3dReference::json;

static_assert(EIGEN_WORLD_VERSION == 3 && EIGEN_MAJOR_VERSION == 4 &&
                EIGEN_MINOR_VERSION == 0,
              "The benchmark requires Eigen 3.4.0");

constexpr std::size_t chunkSize = 12;
constexpr std::size_t releaseChunks = 8;
constexpr std::size_t tailCap = 10000;
constexpr std::size_t repeats = 5;
constexpr double rmsLimit = 0.01;
constexpr double maxMove = 0.18;
using Clock = std::chrono::steady_clock;
using Frame = Eigen::Matrix<double, 3, Eigen::Dynamic>;

struct Bond
{
  Eigen::Index a;
  Eigen::Index b;
  double restLength;
};

std::vector<Bond> referenceBonds(const json& bonds, const Geometry& rest)
{
  std::vector<Bond> result;
  for (const auto& bond : bonds) {
    const auto a = 3 * bond.at("a").get<Eigen::Index>();
    const auto b = 3 * bond.at("b").get<Eigen::Index>();
    result.push_back({ a, b,
                      (rest.positions.segment<3>(a) - rest.positions.segment<3>(b)).norm() });
  }
  return result;
}

json bondGraph(const Molecule& molecule)
{
  json atoms = json::array();
  json bonds = json::array();
  for (size_t i = 0; i < molecule.atomCount(); ++i)
    atoms.push_back({ molecule.atom(i).atomicNumber(), molecule.formalCharge(i) });
  for (size_t i = 0; i < molecule.bondCount(); ++i) {
    const auto bond = molecule.bond(i);
    bonds.push_back({ bond.atom1().index(), bond.atom2().index(), bond.order() });
  }
  return { { "atoms", atoms }, { "bonds", bonds } };
}

struct BondRatios
{
  double compression = 1.0;
  double stretch = 1.0;
};

BondRatios bondRatios(const VectorXd& x, const std::vector<Bond>& bonds)
{
  BondRatios ratios;
  for (const auto& bond : bonds) {
    if (bond.restLength <= 0.001)
      continue;
    const double ratio =
      (x.segment<3>(bond.a) - x.segment<3>(bond.b)).norm() / bond.restLength;
    ratios.compression = std::min(ratios.compression, ratio);
    ratios.stretch = std::max(ratios.stretch, ratio);
  }
  return ratios;
}

double radius(const VectorXd& x)
{
  const Eigen::Map<const Frame> atoms(x.data(), 3, x.size() / 3);
  return std::sqrt((atoms.colwise() - atoms.rowwise().mean()).squaredNorm() / atoms.cols());
}

// Release uses the sidecar's geometry guard at chunk boundaries. The release
// mask here is all-mobile, so the anchored-atom check is vacuous.
const char* guard(const VectorXd& before, const VectorXd& after,
                  const std::vector<Bond>& bonds)
{
  const double beforeRadius = radius(before);
  if (beforeRadius > 1.0 && radius(after) < beforeRadius * 0.82)
    return "radius collapsed";
  const auto oldRatio = bondRatios(before, bonds);
  const auto newRatio = bondRatios(after, bonds);
  if (newRatio.stretch > std::max(3.0, oldRatio.stretch * 1.08))
    return "bond stretched";
  if (newRatio.compression < std::min(0.35, oldRatio.compression * 0.92))
    return "bond collapsed";
  return nullptr;
}

struct StereoWitness
{
  std::string kind;
  std::array<Eigen::Index, 4> atoms{};

  // The tetrahedral witness uses the signed volume of four ordered neighbors.
  // The alkene witness uses the angle between projected priority substituents.
  double measure(const VectorXd& x) const
  {
    const Vector3d a = x.segment<3>(3 * atoms[0]), b = x.segment<3>(3 * atoms[1]);
    const Vector3d c = x.segment<3>(3 * atoms[2]), d = x.segment<3>(3 * atoms[3]);
    if (kind == "tetrahedral")
      return (a - d).normalized().dot((b - d).normalized().cross((c - d).normalized()));
    const Vector3d axis = (c - b).normalized();
    const Vector3d left = axis.cross(a - b);
    const Vector3d right = axis.cross(d - c);
    return left.normalized().dot(right.normalized());
  }
};

int stereoSign(double value)
{
  constexpr double degeneracyThreshold = 1e-3;
  if (!std::isfinite(value) || std::abs(value) <= degeneracyThreshold)
    return 0;
  return value > 0 ? 1 : -1;
}

struct StepTrace
{
  const std::optional<StereoWitness>& stereo;
  double maxEnergy;
  double previousStereo = 0.0;
  std::size_t chunk = 0;
  std::size_t priorIterations = 0;
  std::size_t observedIterations = 0;
  json stereoEvents = json::array();

  void record(const VectorXd& positions, double energy, std::size_t step)
  {
    ++observedIterations;
    maxEnergy = std::max(maxEnergy, energy);
    if (!stereo || !positions.allFinite())
      return;
    const double current = stereo->measure(positions);
    if (stereoSign(current) != stereoSign(previousStereo)) {
      stereoEvents.push_back({ { "chunk", chunk },
                               { "afterIterations", priorIterations + step },
                               { "from", previousStereo }, { "to", current } });
    }
    previousStereo = current;
  }
};

struct TraceScope
{
  TraceScope(StepTrace& trace, bool enabled)
  {
    if (enabled) {
      active = &trace;
      Spin3dBenchmark::acceptedStepObserver = [](const VectorXd& x, double e, std::size_t step) {
        active->record(x, e, step);
      };
    }
  }

  ~TraceScope()
  {
    Spin3dBenchmark::acceptedStepObserver = nullptr;
    active = nullptr;
  }

  static StepTrace* active;
};

StepTrace* TraceScope::active = nullptr;

struct CountingUff : UFF
{
  explicit CountingUff(double initialEnergy) : peakEnergy(initialEnergy) {}

  Avogadro::Real evaluate(const VectorXd& x, VectorXd* grad) override
  {
    ++energyEvaluations;
    if (grad)
      ++forceEvaluations;
    const double energy = UFF::evaluate(x, grad);
    if (std::isfinite(energy))
      peakEnergy = std::max(peakEnergy, energy);
    else
      ++nonfiniteEnergyEvaluations;
    return energy;
  }

  std::size_t forceEvaluations = 0;
  std::size_t energyEvaluations = 0;
  std::size_t nonfiniteEnergyEvaluations = 0;
  double peakEnergy;
};

OptimizationOptions optimizerOptions(OptimizationAlgorithm algorithm)
{
  OptimizationOptions options;
  options.algorithm = algorithm;
  options.chunkIterations = chunkSize;
  options.fire.maxMove = maxMove;
  options.lbfgs.maxStep = maxMove;
  return options;
}

bool willUseLbfgs(const OptimizationOptions& options, const OptimizerState& state)
{
  return options.algorithm == OptimizationAlgorithm::Hybrid &&
         (state.hybridSwitched ||
          (state.initialized && state.gradient.cwiseAbs().maxCoeff() <
                                  options.hybrid.switchGradient));
}

constexpr std::size_t tailRequest(std::size_t remaining, bool useLbfgs)
{
  // At this pin cppoptlib stops after progress exceeds the requested limit.
  // Budget an extra step for L-BFGS. An early stop can still leave one step
  // available, which is too few for another nonzero L-BFGS request.
  if (remaining == 0)
    return 0;
  if (useLbfgs && remaining == chunkSize + 2)
    return chunkSize - 1;
  if (useLbfgs && remaining <= chunkSize)
    return remaining - 1;
  return std::min(chunkSize, remaining);
}

static_assert(tailRequest(5, true) == 4 && tailRequest(1, true) == 0 &&
              tailRequest(1, false) == 1);

double rms(const VectorXd& gradient)
{
  return std::sqrt(gradient.squaredNorm() / gradient.size());
}

json finiteNumber(double value)
{
  // Use the same null representation for repeat comparison and JSON output.
  return std::isfinite(value) ? json(value) : json(nullptr);
}

json triples(const VectorXd& x)
{
  json result = json::array();
  for (Eigen::Index i = 0; i < x.size(); i += 3)
    result.push_back({ finiteNumber(x[i]), finiteNumber(x[i + 1]), finiteNumber(x[i + 2]) });
  return result;
}

struct Run
{
  json observations;
  VectorXd endpoint;
  double wallMs;
  json stepTrace;
};

Run optimize(Geometry& geometry, const std::vector<Bond>& bonds,
             const std::optional<StereoWitness>& stereo,
             OptimizationAlgorithm algorithm, bool tail, double startEnergy,
             double startRms, bool traceSteps)
{
  VectorXd positions = geometry.positions;
  Spin3dReference::setPositions(geometry.molecule, positions);
  CountingUff uff(startEnergy);
  uff.setMolecule(&geometry.molecule);
  const VectorXd mask = VectorXd::Ones(positions.size());
  auto options = optimizerOptions(algorithm);
  OptimizerState state;
  std::size_t chunks = 0, iterations = 0, requestedIterations = 0;
  std::optional<std::size_t> firstConvergence, handoff;
  if (startRms <= rmsLimit)
    firstConvergence = 0;
  const bool validStart = std::isfinite(startEnergy) && std::isfinite(startRms);
  const char* status = validStart ? "capped" : "NaN";
  double finalEnergy = startEnergy, finalRms = startRms;
  double maxChunkEnergy = startEnergy;
  double previousStereo = stereo ? stereo->measure(positions) : 0.0;
  const int initialStereoSign = stereoSign(previousStereo);
  json stereoEvents = json::array();
  json guardRejections = json::array();
  json handoffDetails = nullptr;
  StepTrace trace{ stereo, startEnergy };
  const TraceScope traceScope(trace, traceSteps);

  const auto start = Clock::now();
  while (validStart && (tail ? !firstConvergence && iterations < tailCap
                            : chunks < releaseChunks)) {
    const bool useLbfgs = willUseLbfgs(options, state);
    options.chunkIterations = tail ? tailRequest(tailCap - iterations, useLbfgs) : chunkSize;
    if (options.chunkIterations == 0)
      break; // The remaining budget cannot fit another L-BFGS request.
    const VectorXd before = positions;
    Spin3dReference::setPositions(geometry.molecule, positions);
    uff.setMask(mask);
    Spin3dBenchmark::lbfgsIterations = 0;
    trace.chunk = chunks + 1;
    trace.priorIterations = iterations;
    trace.previousStereo = previousStereo;

    const auto beforeHandoff = state.hybridSwitched;
    const auto switchGradient = useLbfgs ? state.gradient.cwiseAbs().maxCoeff() : 0.0;
    if (!optimizeSteps(uff, positions, options, &state)) {
      status = "failed";
      break;
    }
    if (useLbfgs != state.hybridSwitched ||
        useLbfgs != (Spin3dBenchmark::lbfgsIterations != 0))
      throw std::runtime_error("Pinned optimizer dispatched an unexpected phase");
    if (!beforeHandoff && state.hybridSwitched && !handoff) {
      handoff = iterations;
      handoffDetails = { { "afterIterations", iterations }, { "afterChunks", chunks },
                         { "gradientInfinityNormKjMolAngstrom", switchGradient } };
    }
    ++chunks;
    iterations += useLbfgs ? Spin3dBenchmark::lbfgsIterations : options.chunkIterations;
    requestedIterations += options.chunkIterations;

    if (tail && iterations > tailCap)
      throw std::runtime_error("Exceeded the actual-iteration cap");
    if (!positions.allFinite() || !state.gradient.allFinite() || !std::isfinite(state.energy)) {
      status = "NaN";
      finalEnergy = finalRms = std::numeric_limits<double>::quiet_NaN();
      break;
    }
    if (const char* reason = guard(before, positions, bonds)) {
      guardRejections.push_back({ { "chunk", chunks }, { "afterIterations", iterations },
                                   { "reason", reason } });
      positions = before;
      state = OptimizerState{};
      continue;
    }

    finalEnergy = state.energy;
    finalRms = rms(state.gradient);
    maxChunkEnergy = std::max(maxChunkEnergy, finalEnergy);
    if (!firstConvergence && finalRms <= rmsLimit)
      firstConvergence = iterations;
    if (stereo) {
      const double current = stereo->measure(positions);
      if (stereoSign(current) != stereoSign(previousStereo)) {
        stereoEvents.push_back({ { "chunk", chunks }, { "afterIterations", iterations },
                                 { "from", finiteNumber(previousStereo) },
                                 { "to", finiteNumber(current) } });
      }
      previousStereo = current;
    }
  }
  const auto end = Clock::now();

  if (traceSteps && trace.observedIterations != iterations)
    throw std::runtime_error("Optimizer step observer and iteration count differ");
  if (std::string(status) == "capped" && finalRms <= rmsLimit)
    status = "converged";
  const auto ratios = bondRatios(positions, bonds);
  json observations = {
    { "status", status }, { "iterations", iterations }, { "requestedIterations", requestedIterations },
    { "chunks", chunks }, { "forceEvaluations", uff.forceEvaluations },
    { "energyEvaluations", uff.energyEvaluations },
    { "nonfiniteEnergyEvaluations", uff.nonfiniteEnergyEvaluations },
    { "energyKjMol", finiteNumber(finalEnergy) },
    { "mobileGradientRmsKjMolAngstrom", finiteNumber(finalRms) },
    { "firstConvergedAfterIterations", firstConvergence ? json(*firstConvergence) : json(nullptr) },
    { "handoff", handoffDetails },
    { "maxEvaluatedEnergyKjMol", finiteNumber(uff.peakEnergy) },
    { "everEvaluatedAboveStart", uff.peakEnergy > startEnergy },
    { "maxAcceptedChunkEnergyKjMol", finiteNumber(maxChunkEnergy) },
    { "acceptedChunkEverAboveRunStart", maxChunkEnergy > startEnergy },
    { "guardRejections", guardRejections },
    { "minBondCompressionVsRest", ratios.compression }, { "maxBondStretchVsRest", ratios.stretch },
    { "stereo",
      stereo ? json{ { "endpointWitness", finiteNumber(previousStereo) },
                      { "endpointChanged", stereoSign(previousStereo) != initialStereoSign },
                      { "events", stereoEvents } } : json(nullptr) },
  };
  json stepTrace = { { "observedIterations", trace.observedIterations },
                     { "maxOptimizerStepEnergyKjMol", trace.maxEnergy },
                     { "optimizerStepEverAboveStart", trace.maxEnergy > startEnergy },
                     { "stereoEvents", trace.stereoEvents } };
  return { std::move(observations), std::move(positions),
           std::chrono::duration<double, std::milli>(end - start).count(),
           std::move(stepTrace) };
}

json alignedRmsd(const VectorXd& a, const VectorXd& b, const Molecule& molecule)
{
  if (!a.allFinite() || !b.allFinite())
    return nullptr;
  const Eigen::Map<const Frame> aAtoms(a.data(), 3, a.size() / 3);
  const Eigen::Map<const Frame> bAtoms(b.data(), 3, b.size() / 3);
  const Frame aCentered = aAtoms.colwise() - aAtoms.rowwise().mean();
  const Frame bCentered = bAtoms.colwise() - bAtoms.rowwise().mean();
  Eigen::JacobiSVD<Eigen::Matrix3d> svd(bCentered * aCentered.transpose(),
                                        Eigen::ComputeFullU | Eigen::ComputeFullV);
  const auto& u = svd.matrixU();
  const auto& v = svd.matrixV();
  Eigen::Matrix3d sign = Eigen::Matrix3d::Identity();
  sign(2, 2) = (v * u.transpose()).determinant() < 0 ? -1.0 : 1.0;
  const Frame difference = aCentered - v * sign * u.transpose() * bCentered;
  double heavySquared = 0.0;
  std::size_t heavyCount = 0;
  for (size_t i = 0; i < molecule.atomCount(); ++i) {
    if (molecule.atom(i).atomicNumber() != 1) {
      heavySquared += difference.col(i).squaredNorm();
      ++heavyCount;
    }
  }
  return { { "allAtomAngstrom", std::sqrt(difference.squaredNorm() / difference.cols()) },
           { "heavyAtomAngstrom", std::sqrt(heavySquared / heavyCount) } };
}

json benchmarkPair(Geometry& geometry, const std::vector<Bond>& bonds,
                   const std::optional<StereoWitness>& stereo, bool tail,
                   double initialEnergy, double initialRms)
{
  constexpr std::array algorithms{ OptimizationAlgorithm::AbcFire, OptimizationAlgorithm::Hybrid };
  constexpr std::array names{ "fire", "hybrid" };
  const auto graph = bondGraph(geometry.molecule);
  auto execute = [&](std::size_t method, bool traceSteps) {
    return optimize(geometry, bonds, stereo, algorithms[method], tail, initialEnergy, initialRms,
                    traceSteps);
  };
  // One full warm-up per method with fresh optimizer and UFF state. Alternate
  // execution order for the timed repeats to limit order effects.
  std::array baseline{ execute(0, true), execute(1, true) };
  std::array<std::vector<double>, algorithms.size()> wallMs;
  for (std::size_t repeat = 0; repeat < repeats; ++repeat) {
    for (std::size_t i = 0; i < algorithms.size(); ++i) {
      const auto method = (i + repeat) % algorithms.size();
      const Run result = execute(method, false);
      if (result.observations != baseline[method].observations ||
          triples(result.endpoint) != triples(baseline[method].endpoint))
        throw std::runtime_error("Benchmark results were not repeatable");
      wallMs[method].push_back(result.wallMs);
    }
  }
  if (bondGraph(geometry.molecule) != graph)
    throw std::runtime_error("Optimizer changed the molecular graph");
  json pair;
  for (std::size_t method = 0; method < algorithms.size(); ++method) {
    auto result = baseline[method].observations;
    result["coordinatesAngstrom"] = triples(baseline[method].endpoint);
    result["wallTimesMs"] = wallMs[method];
    auto& samples = wallMs[method];
    std::sort(samples.begin(), samples.end());
    result["medianWallMs"] = samples[repeats / 2];
    result["graphChanged"] = false;
    result["stepTrace"] = baseline[method].stepTrace;
    pair[names[method]] = std::move(result);
  }
  if (!pair["fire"]["energyKjMol"].is_null() && !pair["hybrid"]["energyKjMol"].is_null()) {
    pair["fireMinusHybridEnergyKjMol"] = pair["fire"]["energyKjMol"].get<double>() -
                                        pair["hybrid"]["energyKjMol"].get<double>();
    pair["alignedRmsd"] = alignedRmsd(baseline[0].endpoint, baseline[1].endpoint, geometry.molecule);
  } else {
    pair["fireMinusHybridEnergyKjMol"] = nullptr;
    pair["alignedRmsd"] = nullptr;
  }
  return pair;
}

json benchmark(const json& input)
{
  const auto& atoms = input.at("atoms");
  const auto& bonds = input.at("bonds");
  Geometry rest(atoms, bonds, input.at("restCoordinatesAngstrom"));
  const auto restBonds = referenceBonds(bonds, rest);
  const auto& witness = input.at("stereoWitness");
  std::optional<StereoWitness> stereo;
  if (!witness.is_null())
    stereo = StereoWitness{ witness.at("kind"), witness.at("atoms") };

  json result = json::array();
  for (const auto& snapshot : input.at("starts")) {
    Geometry geometry(atoms, bonds, snapshot.at("coordinatesAngstrom"));
    if (!geometry.positions.allFinite())
      throw std::runtime_error("Starting geometry must be finite");
    UFF probe;
    probe.setMolecule(&geometry.molecule);
    probe.setMask(VectorXd::Ones(geometry.positions.size()));
    VectorXd gradient(geometry.positions.size());
    const double initialEnergy = probe.evaluate(geometry.positions, &gradient);
    const double initialRms = rms(gradient);
    const double initialStereo = stereo ? stereo->measure(geometry.positions) : 0.0;
    if (stereo && (stereoSign(initialStereo) == 0 ||
                   stereoSign(initialStereo) != stereoSign(stereo->measure(rest.positions))))
      throw std::runtime_error("Starting snapshot changed or lost its stereo witness");
    auto record = snapshot;
    record["initialEnergyKjMol"] = initialEnergy;
    record["initialMobileGradientRmsKjMolAngstrom"] = initialRms;
    record["initialStereoWitness"] = stereo ? json(initialStereo) : json(nullptr);
    record["release"] = benchmarkPair(geometry, restBonds, stereo, false, initialEnergy, initialRms);
    record["tail"] = benchmarkPair(geometry, restBonds, stereo, true, initialEnergy, initialRms);
    result.push_back(std::move(record));
  }
  return result;
}

json settings()
{
  const auto options = optimizerOptions(OptimizationAlgorithm::Hybrid);
  const auto& fire = options.fire;
  return { { "eigenVersion", "3.4.0" }, { "eigenThreads", Eigen::nbThreads() },
           { "releaseChunks", releaseChunks }, { "requestedChunkIterations", chunkSize },
           { "actualTailIterationCap", tailCap }, { "timedRepeats", repeats }, { "warmups", 1 },
           { "mobileGradientRmsLimitKjMolAngstrom", rmsLimit },
           { "fire", { { "maxMoveAngstrom", fire.maxMove }, { "dt0", fire.dt0 },
                       { "dtMax", fire.dtMax }, { "alphaStart", fire.alphaStart },
                       { "fAlpha", fire.fAlpha }, { "fInc", fire.fInc }, { "fDec", fire.fDec },
                       { "nDelay", fire.nDelay }, { "mass", fire.mass } } },
           { "hybrid", { { "maxStepAngstrom", options.lbfgs.maxStep },
                         { "wolfeGtol", options.lbfgs.wolfeGtol },
                         { "switchGradientKjMolAngstrom", options.hybrid.switchGradient } } } };
}

void checkNonfiniteRepeats()
{
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const json origin = { { 0.0, 0.0, 0.0 } };
  const json atoms = { { { "atomicNumber", 8 }, { "formalCharge", 0 } } };
  Geometry geometry(atoms, json::array(), origin);
  const auto pair = benchmarkPair(geometry, {}, std::nullopt, false, nan, nan);
  for (const auto* method : { "fire", "hybrid" }) {
    const auto& result = pair.at(method);
    if (result.at("status") != "NaN" || !result.at("energyKjMol").is_null() ||
        !result.at("mobileGradientRmsKjMolAngstrom").is_null())
      throw std::runtime_error("Nonfinite repeat lost its failure row");
  }
  VectorXd positions(3);
  positions << nan, 0.0, 0.0;
  const json expected = { { nullptr, 0.0, 0.0 } };
  if (triples(positions) != expected || triples(positions) == origin)
    throw std::runtime_error("Nonfinite coordinates were not normalized for repeat comparison");
}
} // namespace

int main(int argc, char** argv)
{
  try {
    Eigen::setNbThreads(1);
    if (argc == 2 && std::string(argv[1]) == "--settings") {
      std::cout << settings().dump() << '\n';
    } else if (argc == 2 && std::string(argv[1]) == "--self-test") {
      checkNonfiniteRepeats();
    } else if (argc == 1) {
      std::cout << benchmark(json::parse(std::cin)).dump() << '\n';
    } else {
      throw std::runtime_error("Usage: optimizer-benchmark [--settings | --self-test] or pass input JSON on stdin");
    }
  } catch (const std::exception& error) {
    std::cerr << "Optimizer benchmark: " << error.what() << '\n';
    return 1;
  }
}
