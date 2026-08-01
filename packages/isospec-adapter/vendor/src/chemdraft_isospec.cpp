/*
 * ChemDraft's Embind surface over IsoSpec (BSD-2-Clause, Startek & Lacki).
 *
 * Deliberately thin: IsoSpec is not modified, and this file adds no chemistry. It exposes the two
 * truncation policies `DistributionResult` already models -- FromThreshold (relative intensity) and
 * FromTotalProb (cumulative probability) -- plus the shipped isotope table, so the abundance set a
 * number was computed from can be verified against the binary rather than trusted from the source.
 *
 * Everything returns a JSON string, matching the MinimalLib idiom already used in this repo
 * (`generate_3d_embed`). A malformed formula comes back as {"ok":false,...} rather than trapping the
 * module: IsoSpec throws std::invalid_argument, and an uncaught throw across the Embind boundary
 * would abort the whole WASM instance and take the worker with it.
 */
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <cstddef>
#include <sstream>
#include <string>
#include <vector>

#include "isoSpec++.h"
#include "fixedEnvelopes.h"
#include "element_tables.h"

using namespace IsoSpec;

namespace {

// Enough digits to round-trip a double exactly. Envelope masses are compared against engine
// monoisotopic masses downstream, so a lossy repr here would show up as a spurious disagreement.
std::string num(double v) {
  std::ostringstream out;
  out.precision(17);
  out << v;
  return out.str();
}

std::string escape(const std::string& in) {
  std::string out;
  for (char c : in) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else {
      out += c;
    }
  }
  return out;
}

std::string failure(const std::string& message) {
  return "{\"ok\":false,\"error\":\"" + escape(message) + "\"}";
}

std::string serialize(FixedEnvelope& env, const std::string& policy, double threshold) {
  const double* masses = env.masses();
  const double* probs = env.probs();
  const size_t n = env.confs_no();

  std::ostringstream out;
  out << "{\"ok\":true,\"policy\":\"" << policy << "\",\"threshold\":" << num(threshold)
      << ",\"peakCount\":" << n
      << ",\"coveredProbability\":" << num(env.get_total_prob())
      << ",\"masses\":[";
  for (size_t i = 0; i < n; ++i) {
    if (i) out << ',';
    out << num(masses[i]);
  }
  out << "],\"probabilities\":[";
  for (size_t i = 0; i < n; ++i) {
    if (i) out << ',';
    out << num(probs[i]);
  }
  out << "]}";
  return out.str();
}

}  // namespace

// Relative-intensity threshold: keep peaks at or above `threshold` times the most intense peak.
// `absolute` switches to an absolute probability cut-off instead.
std::string envelope_from_threshold(const std::string& formula, double threshold, bool absolute) {
  try {
    FixedEnvelope env = FixedEnvelope::FromThreshold(Iso(formula.c_str()), threshold, absolute);
    return serialize(env, absolute ? "absolute-probability-threshold" : "relative-intensity-threshold", threshold);
  } catch (const std::exception& e) {
    return failure(e.what());
  } catch (...) {
    return failure("IsoSpec threw a non-standard exception");
  }
}

// The same relative-intensity policy, but over explicitly supplied isotopes rather than a formula.
//
// This exists because IsoSpec's formula parser resolves elements by bare symbol and rejects every
// non-alphanumeric character, so there is no way to spell a site-specific label like [13C] to it. The
// general Iso constructor has no such limit: it takes the isotopes themselves, which lets a labelled
// atom be its own dimension with a single isotope at probability 1.
//
// Arrays are flattened -- `masses` and `probabilities` are read as one run of sum(isotopeCounts)
// entries, in dimension order, which is the layout Iso's flat overload documents and setupMarginals
// indexes by a running sum.
std::string envelope_from_threshold_isotopes(emscripten::val isotopeCounts,
                                             emscripten::val atomCounts,
                                             emscripten::val masses,
                                             emscripten::val probabilities,
                                             double threshold,
                                             bool absolute) {
  try {
    const std::vector<int> counts = emscripten::vecFromJSArray<int>(isotopeCounts);
    const std::vector<int> atoms = emscripten::vecFromJSArray<int>(atomCounts);
    const std::vector<double> ms = emscripten::vecFromJSArray<double>(masses);
    const std::vector<double> ps = emscripten::vecFromJSArray<double>(probabilities);

    if (counts.empty()) return failure("no dimensions supplied");
    if (counts.size() != atoms.size()) return failure("isotopeCounts and atomCounts differ in length");

    size_t total = 0;
    for (size_t i = 0; i < counts.size(); ++i) {
      if (counts[i] < 1) return failure("every dimension needs at least one isotope");
      if (atoms[i] < 0) return failure("an atom count cannot be negative");
      total += static_cast<size_t>(counts[i]);
    }

    // Validated here rather than trusted, because IsoSpec does no bounds checking of its own: it walks
    // the flattened arrays by a running sum of isotopeCounts, so a short array is an out-of-bounds read
    // inside the WASM heap, not an exception this function could catch.
    if (ms.size() != total || ps.size() != total) {
      return failure("masses and probabilities must each hold exactly sum(isotopeCounts) entries");
    }

    size_t at = 0;
    for (size_t i = 0; i < counts.size(); ++i) {
      double sum = 0.0;
      for (int j = 0; j < counts[i]; ++j, ++at) {
        if (!(ps[at] >= 0.0) || ps[at] > 1.0) return failure("an isotope probability is outside [0, 1]");
        sum += ps[at];
      }
      // An unnormalised dimension does not fail loudly downstream -- it silently rescales that
      // element's whole contribution to the envelope, which is exactly the kind of quiet wrong number
      // this wrapper exists to prevent.
      if (std::fabs(sum - 1.0) > 1e-9) return failure("each dimension's probabilities must sum to 1");
    }

    FixedEnvelope env = FixedEnvelope::FromThreshold(
        Iso(static_cast<int>(counts.size()), counts.data(), atoms.data(), ms.data(), ps.data()),
        threshold,
        absolute);
    return serialize(env, absolute ? "absolute-probability-threshold" : "relative-intensity-threshold", threshold);
  } catch (const std::exception& e) {
    return failure(e.what());
  } catch (...) {
    return failure("IsoSpec threw a non-standard exception");
  }
}

// Cumulative probability: smallest peak set covering `targetProb` of the distribution.
std::string envelope_from_total_prob(const std::string& formula, double targetProb, bool optimize) {
  try {
    FixedEnvelope env = FixedEnvelope::FromTotalProb(Iso(formula.c_str()), targetProb, optimize);
    return serialize(env, "cumulative-probability", targetProb);
  } catch (const std::exception& e) {
    return failure(e.what());
  } catch (...) {
    return failure("IsoSpec threw a non-standard exception");
  }
}

// The abundance set actually compiled into this binary. The tables carry no provenance in IsoSpec's
// own repository, and the intensities depend entirely on them, so they have to be inspectable from
// the artifact rather than re-read from source that may not be what was built.
std::string isotope_table() {
  std::ostringstream out;
  out << "{\"entryCount\":" << isospec_number_of_isotopic_entries << ",\"entries\":[";
  for (size_t i = 0; i < isospec_number_of_isotopic_entries; ++i) {
    if (i) out << ',';
    out << "{\"element\":\"" << escape(elem_table_element[i]) << "\""
        << ",\"atomicNumber\":" << elem_table_atomicNo[i]
        << ",\"massNumber\":" << static_cast<long long>(elem_table_massNo[i])
        << ",\"mass\":" << num(elem_table_mass[i])
        << ",\"abundance\":" << num(elem_table_probability[i]) << '}';
  }
  out << "]}";
  return out.str();
}

std::string version() { return CHEMDRAFT_ISOSPEC_VERSION; }

EMSCRIPTEN_BINDINGS(chemdraft_isospec) {
  emscripten::function("envelope_from_threshold", &envelope_from_threshold);
  emscripten::function("envelope_from_threshold_isotopes", &envelope_from_threshold_isotopes);
  emscripten::function("envelope_from_total_prob", &envelope_from_total_prob);
  emscripten::function("isotope_table", &isotope_table);
  emscripten::function("version", &version);
}
