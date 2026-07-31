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
  emscripten::function("envelope_from_total_prob", &envelope_from_total_prob);
  emscripten::function("isotope_table", &isotope_table);
  emscripten::function("version", &version);
}
