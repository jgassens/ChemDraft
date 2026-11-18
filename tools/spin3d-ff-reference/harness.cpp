// SPDX-License-Identifier: Apache-2.0
#include <avogadro/calc/energyoptimizer.h>
#include <avogadro/calc/uff.h>
#include <avogadro/core/atom.h>
#include <avogadro/core/bond.h>
#include <avogadro/core/molecule.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifdef UFF_REFERENCE_DIAGNOSTICS
#include "uff-diagnostics.h"
using ReferenceUff = DiagnosticUff;
#else
using ReferenceUff = Avogadro::Calc::UFF;
#endif

namespace {
using Avogadro::Calc::KCAL_TO_KJ;
using Avogadro::Calc::OptimizationAlgorithm;
using Avogadro::Calc::OptimizationOptions;
using Avogadro::Calc::OptimizerState;
using Avogadro::Calc::UFF;
using Avogadro::Core::Molecule;
using Eigen::VectorXd;
using nlohmann::json;

static_assert(EIGEN_WORLD_VERSION == 3 && EIGEN_MAJOR_VERSION == 4 &&
                EIGEN_MINOR_VERSION == 0,
              "The UFF reference requires Eigen 3.4.0");

constexpr std::array<double, 2> differenceSteps{ 1e-5, 5e-6 };
constexpr std::array<int, 3> checkpointIterations{ 1, 10, 100 };
constexpr int iterationCap = 10000;
constexpr double convergenceRms = 1e-2;

struct Term
{
  const char* name;
  double (UFF::*energy)(const VectorXd&);
  void (UFF::*gradient)(const VectorXd&, VectorXd&);
};

constexpr std::array<Term, 5> terms{ {
  { "bond", &UFF::bondEnergy, &UFF::bondGradient },
  { "angle", &UFF::angleEnergy, &UFF::angleGradient },
  { "oop", &UFF::oopEnergy, &UFF::oopGradient },
  { "torsion", &UFF::torsionEnergy, &UFF::torsionGradient },
  { "vdw", &UFF::vdwEnergy, &UFF::vdwGradient },
} };

std::vector<double> numbers(const VectorXd& vector)
{
  return { vector.data(), vector.data() + vector.size() };
}

void setPositions(Molecule& molecule, const VectorXd& x)
{
  for (size_t i = 0; i < molecule.atomCount(); ++i)
    molecule.atom(i).setPosition3d(x.segment<3>(3 * i));
}

void checkScanLimitGeometry(const json& bonds, const VectorXd& x)
{
  // The pin leaves row -1 for Z > 100. Bonded and vdW setup would dereference
  // that row. Only probe scan coverage in isolated, static, far-apart graphs.
  if (!bonds.empty())
    throw std::runtime_error("Scan-limit atoms must be unbonded");
  for (Eigen::Index i = 0; i < x.size(); i += 3) {
    for (Eigen::Index j = i + 3; j < x.size(); j += 3) {
      if ((x.segment<3>(i) - x.segment<3>(j)).squaredNorm() <= 121)
        throw std::runtime_error("Scan-limit atoms must stay beyond the vdW cutoff");
    }
  }
}

struct Geometry
{
  Molecule molecule;
  VectorXd positions;
  bool probesScanLimit = false;

  Geometry(const json& atoms, const json& bonds, const json& coordinates)
    : positions(3 * atoms.size())
  {
    if (atoms.empty() || coordinates.size() != atoms.size())
      throw std::runtime_error("Expected one coordinate triple per atom");
    for (size_t i = 0; i < atoms.size(); ++i) {
      const auto xyz = coordinates.at(i).get<std::array<double, 3>>();
      positions.segment<3>(3 * i) = Eigen::Vector3d(xyz[0], xyz[1], xyz[2]);
      const int z = atoms[i].at("atomicNumber").get<int>();
      const int charge = atoms[i].at("formalCharge").get<int>();
      if (z <= 0 || z > 103 || charge < -128 || charge > 127)
        throw std::runtime_error("Atom lies outside the pinned oracle's safe input range");
      probesScanLimit = probesScanLimit || z > 100;
      if (!molecule.addAtom(static_cast<unsigned char>(z)).isValid() ||
          !molecule.setFormalCharge(i, static_cast<signed char>(charge)))
        throw std::runtime_error("Avogadro rejected an atom or its charge");
    }
    if (probesScanLimit)
      checkScanLimitGeometry(bonds, positions);
    for (const auto& bond : bonds) {
      const size_t a = bond.at("a").get<size_t>();
      const size_t b = bond.at("b").get<size_t>();
      const int order = bond.at("order").get<int>();
      if (a >= atoms.size() || b >= atoms.size() || a == b || order < 1 || order > 3 ||
          !molecule.addBond(a, b, static_cast<unsigned char>(order)).isValid())
        throw std::runtime_error("Avogadro rejected a bond");
    }
    setPositions(molecule, positions);
  }
};

VectorXd centralDifference(UFF& uff, const VectorXd& x,
                           double (UFF::*energy)(const VectorXd&), double h)
{
  VectorXd result(x.size());
  VectorXd sample = x;
  for (Eigen::Index i = 0; i < x.size(); ++i) {
    sample[i] = x[i] + h;
    const double plus = (uff.*energy)(sample);
    sample[i] = x[i] - h;
    const double minus = (uff.*energy)(sample);
    sample[i] = x[i];
    result[i] = (plus - minus) / (2 * h);
  }
  return result;
}

json differences(UFF& uff, const VectorXd& x, double (UFF::*energy)(const VectorXd&),
                 double scale)
{
  json output = json::array();
  for (const double h : differenceSteps)
    output.push_back(numbers(scale * centralDifference(uff, x, energy, h)));
  return output;
}

json evaluateSnapshot(Geometry& geometry, const json& snapshot)
{
  ReferenceUff uff;
  uff.setMolecule(&geometry.molecule);
  const VectorXd& x = geometry.positions;
  json output = { { "id", snapshot.at("id") },
                  { "gradientCheck", snapshot.at("gradientCheck") } };
#ifdef UFF_REFERENCE_DIAGNOSTICS
  // Capture the term setup before evaluating any displaced coordinates.
  output["topology"] = uff.topology();
#endif
  VectorXd gradient = VectorXd::Zero(x.size());
  const double value = uff.value(x);
  const double evaluated = uff.evaluate(x, &gradient);
  output["total"] = {
    { "valueKjMol", value },
    { "evaluateKjMol", evaluated },
    { "gradientKjMolAngstrom", numbers(gradient) },
    { "centralDifferenceKjMolAngstrom", differences(uff, x, &UFF::value, 1.0) },
  };
  for (const Term& term : terms) {
    const double energy = (uff.*term.energy)(x);
    gradient.setZero();
    (uff.*term.gradient)(x, gradient);
    const json rawDifferences = differences(uff, x, term.energy, 1.0);
    json normalizedDifferences = rawDifferences;
    for (auto& step : normalizedDifferences) {
      for (auto& component : step)
        component = component.get<double>() * KCAL_TO_KJ;
    }
    output["terms"][term.name] = {
      { "energyKcalMol", energy },
      { "energyKjMol", energy * KCAL_TO_KJ },
      { "gradientKcalMolAngstrom", numbers(gradient) },
      { "gradientKjMolAngstrom", numbers(KCAL_TO_KJ * gradient) },
      { "centralDifferenceKcalMolAngstrom", rawDifferences },
      { "centralDifferenceKjMolAngstrom", normalizedDifferences },
    };
  }
  return output;
}

json evaluateCutoffCrossing(const json& graph)
{
  const auto& crossing = graph.at("cutoffCrossing");
  const auto& snapshots = graph.at("snapshots");
  const auto& snapshotIds = crossing.at("snapshotIds");
  const auto geometryAt = [&](const json& id) {
    const auto snapshot = std::find_if(snapshots.begin(), snapshots.end(),
                                      [&](const json& sample) { return sample.at("id") == id; });
    if (snapshot == snapshots.end())
      throw std::runtime_error("Unknown cutoff-crossing snapshot " + id.dump());
    return Geometry(graph.at("atoms"), graph.at("bonds"), snapshot->at("coordinatesAngstrom"));
  };
  const auto evaluate = [](UFF& uff, const VectorXd& positions) {
    VectorXd gradient = VectorXd::Zero(positions.size());
    const double energy = uff.evaluate(positions, &gradient);
    return json{ { "energyKjMol", energy }, { "gradientKjMolAngstrom", numbers(gradient) } };
  };
  auto initial = geometryAt(snapshotIds.at(0));
  ReferenceUff persistent;
  persistent.setMolecule(&initial.molecule);
  json steps = json::array();
  // One evaluate() per model per step. Extra calls would advance the pair-list counter.
  for (const auto& id : snapshotIds) {
    auto geometry = geometryAt(id);
    ReferenceUff fresh;
    fresh.setMolecule(&geometry.molecule);
    steps.push_back({ { "snapshotId", id },
                      { "persistent", evaluate(persistent, geometry.positions) },
                      { "fresh", evaluate(fresh, geometry.positions) } });
  }
  return { { "gradientCheck", crossing.at("gradientCheck") }, { "steps", std::move(steps) } };
}

OptimizationOptions optimizerOptions(OptimizationAlgorithm algorithm)
{
  OptimizationOptions options;
  options.algorithm = algorithm;
  options.fire.dt0 = 0.05;
  options.fire.dtMax = 0.5;
  options.fire.alphaStart = 0.25;
  options.fire.fAlpha = 0.99;
  options.fire.fInc = 1.1;
  options.fire.fDec = 0.5;
  options.fire.nDelay = 5;
  options.fire.maxMove = 0.18;
  options.fire.mass = 1.0;
  return options;
}

struct Trajectory
{
  UFF uff;
  VectorXd positions;
  VectorXd mask;
  OptimizationOptions options;
  OptimizerState state;
  int iteration = 0;

  Trajectory(Geometry& geometry, const VectorXd& mobileMask, const OptimizationOptions& settings)
    : positions(geometry.positions), mask(mobileMask), options(settings)
  {
    uff.setMolecule(&geometry.molecule);
    if (mask.size() != 0)
      uff.setMask(mask);
  }

  void advance(int steps)
  {
    options.chunkIterations = steps;
    if (!Avogadro::Calc::optimizeSteps(uff, positions, options, &state))
      throw std::runtime_error("Avogadro rejected FIRE options");
    iteration += steps;
  }

  double rms(const VectorXd& gradient) const
  {
    const double mobile = mask.size() == 0 ? positions.size() : mask.sum();
    return std::sqrt(gradient.squaredNorm() / mobile);
  }

  json checkpoint() const
  {
    return { { "iteration", iteration },
             { "coordinatesAngstrom", numbers(positions) },
             { "energyKjMol", state.energy },
             { "gradientKjMolAngstrom", numbers(state.gradient) },
             { "mobileGradientRmsKjMolAngstrom", rms(state.gradient) },
             { "velocity", numbers(state.velocity) },
             { "dt", state.dt },
             { "alpha", state.alpha },
             { "positivePowerCount", state.nPos } };
  }
};

void checkChunking(Geometry& geometry, const Trajectory& reference, int chunkSize)
{
  Trajectory replay(geometry, reference.mask, reference.options);
  while (replay.iteration < reference.iteration)
    replay.advance(std::min(chunkSize, reference.iteration - replay.iteration));
  // All calls run the same ordered iterations and restore the same state.
  if (replay.checkpoint() != reference.checkpoint())
    throw std::runtime_error("FIRE checkpoints changed with chunk size");
}

json optimize(Geometry& geometry, const json& run)
{
  if (geometry.probesScanLimit)
    throw std::runtime_error("Scan-limit probes only support fixed snapshots");
  const auto algorithmName = run.at("algorithm").get<std::string>();
  if (algorithmName != "ABC-FIRE" && algorithmName != "FIRE2")
    throw std::runtime_error("Unknown FIRE algorithm " + algorithmName);
  const auto algorithm = algorithmName == "ABC-FIRE" ? OptimizationAlgorithm::AbcFire
                                                     : OptimizationAlgorithm::Fire2;
  const auto frozen = run.at("frozenCoordinates").get<std::vector<size_t>>();
  VectorXd mask;
  if (!frozen.empty()) {
    mask = VectorXd::Ones(geometry.positions.size());
    for (const auto index : frozen) {
      if (index >= static_cast<size_t>(mask.size()) || mask[index] == 0)
        throw std::runtime_error("Invalid frozen coordinate index");
      mask[index] = 0;
    }
    if (mask.sum() == 0)
      throw std::runtime_error("FIRE mask freezes every coordinate");
  }
  Trajectory trajectory(geometry, mask, optimizerOptions(algorithm));
  VectorXd initialGradient;
  const double initialEnergy = trajectory.uff.evaluate(trajectory.positions, &initialGradient);
  json output = {
    { "algorithm", algorithmName }, { "frozenCoordinates", frozen },
    { "initialEnergyKjMol", initialEnergy },
    { "initialGradientKjMolAngstrom", numbers(initialGradient) },
    { "initialMobileGradientRmsKjMolAngstrom", trajectory.rms(initialGradient) },
    { "checkpoints", json::array() },
  };
  for (int i = 1; i <= iterationCap; ++i) {
    trajectory.advance(1);
    const bool converged = trajectory.rms(trajectory.state.gradient) <= convergenceRms;
    if (!output.contains("endpoint") && (converged || i == iterationCap)) {
      checkChunking(geometry, trajectory, i);
      checkChunking(geometry, trajectory, 10);
      output["endpoint"] = trajectory.checkpoint();
      output["endpoint"]["status"] = converged ? "converged" : "capped";
    }
    for (const int checkpoint : checkpointIterations) {
      if (i == checkpoint) {
        checkChunking(geometry, trajectory, i);
        checkChunking(geometry, trajectory, 10);
        output["checkpoints"].push_back(trajectory.checkpoint());
      }
    }
    if (i >= checkpointIterations.back() && output.contains("endpoint"))
      break;
  }
  return output;
}

json settings()
{
  const auto fire = optimizerOptions(OptimizationAlgorithm::AbcFire).fire;
  return { { "eigenVersion", "3.4.0" },
           { "kcalToKj", KCAL_TO_KJ },
           { "centralDifferenceStepsAngstrom", differenceSteps },
           { "generalRestraints", false },
           { "vdwCutoffAngstrom", 10 },
           { "optimizer",
             { { "checkpointIterations", checkpointIterations }, { "iterationCap", iterationCap },
               { "convergenceMobileGradientRmsKjMolAngstrom", convergenceRms },
               { "verificationChunkSizes", { "single-call", "10-iterations" } },
               { "fire",
                 { { "dt0", fire.dt0 }, { "dtMax", fire.dtMax }, { "alphaStart", fire.alphaStart },
                   { "fAlpha", fire.fAlpha }, { "fInc", fire.fInc }, { "fDec", fire.fDec },
                   { "nDelay", fire.nDelay }, { "maxMoveAngstrom", fire.maxMove },
                   { "mass", fire.mass } } } } } };
}

json evaluateInput(const json& input)
{
  json output = { { "id", input.at("id") }, { "graphs", json::array() } };
  for (const auto& graph : input.at("graphs")) {
    json result = { { "hydrogenModel", graph.at("hydrogenModel") },
                    { "snapshots", json::array() } };
    if (graph.contains("kekule"))
      result["kekule"] = graph.at("kekule");
    for (const auto& snapshot : graph.at("snapshots")) {
      Geometry geometry(graph.at("atoms"), graph.at("bonds"), snapshot.at("coordinatesAngstrom"));
      auto record = evaluateSnapshot(geometry, snapshot);
      if (snapshot.contains("optimizationRuns")) {
        record["optimizationRuns"] = json::array();
        for (const auto& run : snapshot.at("optimizationRuns"))
          record["optimizationRuns"].push_back(optimize(geometry, run));
      }
      result["snapshots"].push_back(std::move(record));
    }
    if (graph.contains("cutoffCrossing"))
      result["cutoffCrossing"] = evaluateCutoffCrossing(graph);
    output["graphs"].push_back(std::move(result));
  }
  return output;
}
} // namespace

int main(int argc, char** argv)
{
  try {
    if (argc == 2 && std::string(argv[1]) == "--settings") {
      std::cout << settings().dump() << '\n';
      return 0;
    }
    if (argc != 1)
      throw std::runtime_error("Usage: uff-reference < INPUT.json or uff-reference --settings");
    std::cout << evaluateInput(json::parse(std::cin)).dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "UFF reference: " << error.what() << '\n';
    return 1;
  }
}
