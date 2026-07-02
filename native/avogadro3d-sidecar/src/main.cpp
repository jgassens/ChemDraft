#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
#include <Eigen/Core>
#include <Eigen/Dense>
#include <avogadro/calc/energyoptimizer.h>
#include <avogadro/calc/uff.h>
#include <avogadro/core/elements.h>
#include <avogadro/core/molecule.h>
#include <avogadro/core/vector.h>
#endif

namespace {

constexpr int kProtocolVersion = 2;

struct Coordinate {
  double x;
  double y;
  double z;
};

struct Bond {
  int from;
  int to;
  int order;
};

struct MolfileGeometry {
  std::vector<std::string> elements;
  std::vector<Coordinate> coordinates;
  std::vector<Bond> bonds;
  std::vector<int> formalCharges;
};

struct ForceFieldReport {
  bool avogadroBacked;
  bool ok;
  std::string name;
  std::string status;
  double energy;
  std::string warning;
};

ForceFieldReport notRunForceFieldReport() {
  return {
      false,
      false,
      "avogadro-placeholder",
      "not-run",
      std::numeric_limits<double>::quiet_NaN(),
      "Avogadro Core/Calc was not linked in this build."};
}

ForceFieldReport avogadroArmedForceFieldReport() {
  return {
      true,
      true,
      "UFF",
      "armed",
      std::numeric_limits<double>::quiet_NaN(),
      ""};
}

std::string jsonNumber(double value) {
  if (!std::isfinite(value)) {
    return "null";
  }
  std::ostringstream out;
  out << std::setprecision(10) << value;
  return out.str();
}

std::string jsonEscape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (const char ch : value) {
    if (ch == '"' || ch == '\\') {
      escaped.push_back('\\');
    }
    escaped.push_back(ch);
  }
  return escaped;
}

std::string forceFieldJson(const ForceFieldReport& report) {
  std::ostringstream out;
  out << "{\"name\":\"" << jsonEscape(report.name)
      << "\",\"status\":\"" << jsonEscape(report.status) << "\"";
  if (std::isfinite(report.energy)) {
    out << ",\"energy\":" << jsonNumber(report.energy)
        << ",\"energyUnits\":\"kJ/mol\"";
  }
  out << ",\"avogadroBacked\":" << (report.avogadroBacked ? "true" : "false");
  if (!report.warning.empty()) {
    out << ",\"warning\":\"" << jsonEscape(report.warning) << "\"";
  }
  out << "}";
  return out.str();
}

std::string warningsJson(const ForceFieldReport& report) {
  if (report.warning.empty()) {
    return "[]";
  }
  return "[\"" + jsonEscape(report.warning) + "\"]";
}

std::string jsonUnescape(const std::string& value) {
  std::string unescaped;
  unescaped.reserve(value.size());
  bool escaped = false;
  for (const char ch : value) {
    if (escaped) {
      switch (ch) {
        case 'n':
          unescaped.push_back('\n');
          break;
        case 'r':
          unescaped.push_back('\r');
          break;
        case 't':
          unescaped.push_back('\t');
          break;
        case '"':
        case '\\':
        case '/':
          unescaped.push_back(ch);
          break;
        default:
          unescaped.push_back(ch);
          break;
      }
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    unescaped.push_back(ch);
  }
  return unescaped;
}

std::string jsonStringValue(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return "";
  }
  const std::size_t colon = json.find(':', keyPos + needle.size());
  if (colon == std::string::npos) {
    return "";
  }
  const std::size_t startQuote = json.find('"', colon + 1);
  if (startQuote == std::string::npos) {
    return "";
  }
  std::string raw;
  bool escaped = false;
  for (std::size_t index = startQuote + 1; index < json.size(); ++index) {
    const char ch = json[index];
    if (escaped) {
      raw.push_back('\\');
      raw.push_back(ch);
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') {
      return jsonUnescape(raw);
    }
    raw.push_back(ch);
  }
  return "";
}

std::vector<std::string> jsonStringArrayValue(const std::string& json, const std::string& key) {
  std::vector<std::string> values;
  const std::string needle = "\"" + key + "\"";
  const std::size_t keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return values;
  }
  const std::size_t colon = json.find(':', keyPos + needle.size());
  const std::size_t open = colon == std::string::npos ? std::string::npos : json.find('[', colon + 1);
  const std::size_t close = open == std::string::npos ? std::string::npos : json.find(']', open + 1);
  if (open == std::string::npos || close == std::string::npos) {
    return values;
  }

  std::size_t cursor = open + 1;
  while (cursor < close) {
    const std::size_t startQuote = json.find('"', cursor);
    if (startQuote == std::string::npos || startQuote >= close) {
      break;
    }
    std::string value;
    bool escaped = false;
    for (std::size_t index = startQuote + 1; index < close; ++index) {
      const char ch = json[index];
      if (escaped) {
        value.push_back(ch);
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (ch == '"') {
        values.push_back(value);
        cursor = index + 1;
        break;
      }
      value.push_back(ch);
    }
    if (cursor <= startQuote) {
      break;
    }
  }
  return values;
}

unsigned int jsonUIntValue(const std::string& json, const std::string& key, unsigned int fallback) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return fallback;
  }
  const std::size_t colon = json.find(':', keyPos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  const std::size_t start = json.find_first_of("0123456789", colon + 1);
  if (start == std::string::npos) {
    return fallback;
  }
  const std::size_t end = json.find_first_not_of("0123456789", start);
  const std::string raw = json.substr(start, end == std::string::npos ? std::string::npos : end - start);
  char* parsedEnd = nullptr;
  const unsigned long value = std::strtoul(raw.c_str(), &parsedEnd, 10);
  return parsedEnd == raw.c_str() ? fallback : static_cast<unsigned int>(value);
}

double jsonDoubleValue(const std::string& json, const std::string& key, double fallback) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return fallback;
  }
  const std::size_t colon = json.find(':', keyPos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  const std::size_t start = json.find_first_of("-0123456789.", colon + 1);
  if (start == std::string::npos) {
    return fallback;
  }
  const std::size_t end = json.find_first_not_of("-0123456789.eE+", start);
  const std::string raw = json.substr(start, end == std::string::npos ? std::string::npos : end - start);
  char* parsedEnd = nullptr;
  const double value = std::strtod(raw.c_str(), &parsedEnd);
  return parsedEnd == raw.c_str() ? fallback : value;
}

std::string jsonObjectValue(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return "";
  }
  const std::size_t colon = json.find(':', keyPos + needle.size());
  const std::size_t open = colon == std::string::npos ? std::string::npos : json.find('{', colon + 1);
  if (open == std::string::npos) {
    return "";
  }

  bool inString = false;
  bool escaped = false;
  int depth = 0;
  for (std::size_t index = open; index < json.size(); ++index) {
    const char ch = json[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch == '{') {
      ++depth;
    } else if (ch == '}') {
      --depth;
      if (depth == 0) {
        return json.substr(open, index - open + 1);
      }
    }
  }
  return "";
}

std::vector<Coordinate> coords3dByAtomIdValue(
    const std::string& json,
    const std::vector<std::string>& atomIds) {
  const std::string coordinatesObject = jsonObjectValue(json, "coords3dByAtomId");
  if (coordinatesObject.empty() || atomIds.empty()) {
    return {};
  }

  std::vector<Coordinate> coordinates;
  coordinates.reserve(atomIds.size());
  for (const std::string& atomId : atomIds) {
    const std::string atomObject = jsonObjectValue(coordinatesObject, atomId);
    if (atomObject.empty()) {
      return {};
    }
    const Coordinate coordinate{
        jsonDoubleValue(atomObject, "x", std::numeric_limits<double>::quiet_NaN()),
        jsonDoubleValue(atomObject, "y", std::numeric_limits<double>::quiet_NaN()),
        jsonDoubleValue(atomObject, "z", std::numeric_limits<double>::quiet_NaN())};
    if (!std::isfinite(coordinate.x) || !std::isfinite(coordinate.y) || !std::isfinite(coordinate.z)) {
      return {};
    }
    coordinates.push_back(coordinate);
  }
  return coordinates;
}

std::string requestId(const std::string& line) {
  const std::string id = jsonStringValue(line, "requestId");
  return id.empty() ? "sidecar-request" : id;
}

std::string sessionId(const std::string& line, const std::string& fallback) {
  const std::string id = jsonStringValue(line, "sessionId");
  return id.empty() ? fallback : id;
}

std::string responsePrefix(const std::string& id, const std::string& session) {
  std::string prefix = "{\"protocolVersion\":" + std::to_string(kProtocolVersion) +
                       ",\"requestId\":\"" + id + "\"";
  if (!session.empty()) {
    prefix += ",\"sessionId\":\"" + session + "\"";
  }
  prefix += ",\"type\":\"response\"";
  return prefix;
}

std::string coordinateJson(const Coordinate& coordinate) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(4)
      << "{\"x\":" << coordinate.x
      << ",\"y\":" << coordinate.y
      << ",\"z\":" << coordinate.z << "}";
  return out.str();
}

std::string coordinatesByAtomJson(
    const std::vector<std::string>& atomIds,
    const std::vector<Coordinate>& coordinates) {
  std::ostringstream out;
  out << "{";
  for (std::size_t index = 0; index < atomIds.size() && index < coordinates.size(); ++index) {
    if (index > 0) {
      out << ",";
    }
    out << "\"" << jsonEscape(atomIds[index]) << "\":" << coordinateJson(coordinates[index]);
  }
  out << "}";
  return out.str();
}

std::string selectedAtomIdsJson(const std::vector<std::string>& atomIds, int index) {
  if (index < 0 || static_cast<std::size_t>(index) >= atomIds.size()) {
    return "[]";
  }
  return "[\"" + jsonEscape(atomIds[static_cast<std::size_t>(index)]) + "\"]";
}

std::vector<std::string> splitLines(const std::string& value) {
  std::vector<std::string> lines;
  std::string line;
  std::istringstream stream(value);
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    lines.push_back(line);
  }
  return lines;
}

int intField(const std::string& line, std::size_t start, std::size_t length, int fallback = 0) {
  if (start >= line.size()) {
    return fallback;
  }
  const std::string raw = line.substr(start, std::min(length, line.size() - start));
  char* parsedEnd = nullptr;
  const long value = std::strtol(raw.c_str(), &parsedEnd, 10);
  return parsedEnd == raw.c_str() ? fallback : static_cast<int>(value);
}

std::string stringField(const std::string& line, std::size_t start, std::size_t length) {
  if (start >= line.size()) {
    return "";
  }
  std::string raw = line.substr(start, std::min(length, line.size() - start));
  const std::size_t first = raw.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) {
    return "";
  }
  const std::size_t last = raw.find_last_not_of(" \t\r\n");
  return raw.substr(first, last - first + 1);
}

double doubleField(const std::string& line, std::size_t start, std::size_t length, double fallback = 0.0) {
  const std::string raw = stringField(line, start, length);
  if (raw.empty()) {
    return fallback;
  }
  char* parsedEnd = nullptr;
  const double value = std::strtod(raw.c_str(), &parsedEnd);
  return parsedEnd == raw.c_str() ? fallback : value;
}

int molfileBondOrder(int order) {
  switch (order) {
    case 2:
      return 2;
    case 3:
      return 3;
    default:
      return 1;
  }
}

int chargeFromV2000AtomCode(int code) {
  switch (code) {
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 1;
    case 5:
      return -1;
    case 6:
      return -2;
    case 7:
      return -3;
    default:
      return 0;
  }
}

MolfileGeometry parseMolfileGeometry(
    const std::string& molfile,
    const std::vector<std::string>& atomIds) {
  MolfileGeometry geometry;
  const std::vector<std::string> lines = splitLines(molfile);
  std::size_t countsIndex = std::string::npos;
  int atomCount = 0;
  int bondCount = 0;
  for (std::size_t index = 0; index < lines.size(); ++index) {
    if (lines[index].find("V2000") == std::string::npos && lines[index].find("V3000") == std::string::npos) {
      continue;
    }
    atomCount = intField(lines[index], 0, 3);
    bondCount = intField(lines[index], 3, 3);
    if (atomCount > 0) {
      countsIndex = index;
      break;
    }
  }
  if (countsIndex == std::string::npos || atomCount <= 0) {
    return geometry;
  }
  geometry.formalCharges.resize(static_cast<std::size_t>(atomCount), 0);

  const std::size_t atomLineStart = countsIndex + 1;
  for (int atomIndex = 0; atomIndex < atomCount && atomLineStart + atomIndex < lines.size(); ++atomIndex) {
    const std::string& line = lines[atomLineStart + atomIndex];
    geometry.coordinates.push_back({
        doubleField(line, 0, 10),
        doubleField(line, 10, 10),
        doubleField(line, 20, 10)});
    const std::string element = stringField(line, 31, 3);
    geometry.elements.push_back(element.empty() ? "C" : element);
    geometry.formalCharges[static_cast<std::size_t>(atomIndex)] =
        chargeFromV2000AtomCode(intField(line, 36, 3, 0));
  }

  const std::size_t bondLineStart = atomLineStart + static_cast<std::size_t>(atomCount);
  for (int bondIndex = 0; bondIndex < bondCount && bondLineStart + bondIndex < lines.size(); ++bondIndex) {
    const std::string& line = lines[bondLineStart + bondIndex];
    const int from = intField(line, 0, 3) - 1;
    const int to = intField(line, 3, 3) - 1;
    if (from < 0 || to < 0 || from >= atomCount || to >= atomCount) {
      continue;
    }
    geometry.bonds.push_back({from, to, molfileBondOrder(intField(line, 6, 3, 1))});
  }

  bool chgLineSeen = false;
  for (std::size_t lineIndex = bondLineStart + static_cast<std::size_t>(bondCount);
       lineIndex < lines.size();
       ++lineIndex) {
    const std::string& line = lines[lineIndex];
    if (line.rfind("M  END", 0) == 0) {
      break;
    }
    if (line.rfind("M  CHG", 0) != 0) {
      continue;
    }
    if (!chgLineSeen) {
      std::fill(geometry.formalCharges.begin(), geometry.formalCharges.end(), 0);
      chgLineSeen = true;
    }
    std::istringstream fields(line.substr(6));
    int pairCount = 0;
    fields >> pairCount;
    for (int pairIndex = 0; pairIndex < pairCount; ++pairIndex) {
      int atomNumber = 0;
      int charge = 0;
      fields >> atomNumber >> charge;
      const int atomIndex = atomNumber - 1;
      if (atomIndex >= 0 && atomIndex < atomCount) {
        geometry.formalCharges[static_cast<std::size_t>(atomIndex)] = charge;
      }
    }
  }

  if (!atomIds.empty() && geometry.coordinates.size() > atomIds.size()) {
    geometry.coordinates.resize(atomIds.size());
    geometry.elements.resize(atomIds.size());
    geometry.formalCharges.resize(atomIds.size());
  }
  return geometry;
}

void emitOk(const std::string& id, const std::string& session, const std::string& result = "") {
  std::cout << responsePrefix(id, session) << ",\"ok\":true";
  if (!result.empty()) {
    std::cout << ",\"result\":" << result;
  }
  std::cout << "}" << std::endl;
}

void emitError(const std::string& id, const std::string& session, const std::string& message) {
  std::cout << responsePrefix(id, session)
            << ",\"ok\":false,\"error\":\"" << message << "\"}" << std::endl;
}

void emitReadyEvent(
    const std::string& id,
    const std::string& session,
    const std::vector<std::string>& atomIds,
    const std::vector<Coordinate>& coordinates) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion
            << ",\"requestId\":\"" << id << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"eventType\":\"ready\","
            << "\"capabilities\":{\"headlessPhysics\":true,"
            << "\"worldSpaceDrag\":true,\"frontendRendering\":true,"
            << "\"autoOptimize\":true,\"forceField\":\"UFF\"},"
            << "\"coordinateRevision\":0,"
            << "\"coords3dByAtomId\":" << coordinatesByAtomJson(atomIds, coordinates) << "}"
            << std::endl;
}

void emitEvent(const std::string& id, const std::string& session, const std::string& eventType) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion << ",\"requestId\":\"" << id
            << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"eventType\":\"" << eventType << "\"}" << std::endl;
}

void emitEnergyChanged(
    const std::string& id,
    const std::string& session,
    const ForceFieldReport& report) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion << ",\"requestId\":\"" << id
            << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"eventType\":\"energyChanged\","
            << "\"energy\":" << jsonNumber(report.energy)
            << ",\"forceField\":" << forceFieldJson(report) << "}" << std::endl;
}

void emitCoordinatesChanged(
    const std::string& id,
    const std::string& session,
    unsigned int coordinateRevision,
    const std::vector<std::string>& atomIds,
    const std::vector<Coordinate>& coordinates,
    const std::string& reason) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion << ",\"requestId\":\"" << id
            << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"eventType\":\"coordinatesChanged\","
            << "\"coordinateRevision\":" << coordinateRevision
            << ",\"reason\":\"" << jsonEscape(reason) << "\""
            << ",\"coords3dByAtomId\":" << coordinatesByAtomJson(atomIds, coordinates) << "}" << std::endl;
}

void emitCommit(
    const std::string& id,
    const std::string& session,
    unsigned int coordinateRevision,
    const std::string& graphSignature,
    const std::string& bondSignature,
    const std::vector<std::string>& atomIds,
    const std::vector<Coordinate>& coordinates,
    const ForceFieldReport& report) {
  std::cout << responsePrefix(id, session)
            << ",\"ok\":true,\"result\":{\"sessionId\":\"" << session
            << "\",\"coords3dByAtomId\":" << coordinatesByAtomJson(atomIds, coordinates) << ","
            << "\"coordinateRevision\":" << coordinateRevision
            << ",\"graphSignature\":\"" << jsonEscape(graphSignature)
            << "\",\"bondSignature\":\"" << jsonEscape(bondSignature)
            << "\",\"engine\":{\"name\":\"avogadro3d-sidecar\",\"version\":\"protocol-scout\","
            << "\"sourceCommit\":\"" << CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT << "\"},"
            << "\"forceField\":" << forceFieldJson(report) << ","
            << "\"warnings\":" << warningsJson(report) << "}}"
            << std::endl;
}

std::vector<Coordinate> defaultCoordinatesForAtoms(const std::vector<std::string>& atomIds) {
  std::vector<Coordinate> coordinates;
  coordinates.reserve(atomIds.size());
  for (std::size_t index = 0; index < atomIds.size(); ++index) {
    coordinates.push_back({
        static_cast<double>(index % 12) * 1.4,
        static_cast<double>(index / 12) * 1.2,
        (static_cast<int>(index % 5) - 2) * 0.08});
  }
  return coordinates;
}

std::vector<std::string> defaultElementsForAtoms(const std::vector<std::string>& atomIds) {
  return std::vector<std::string>(atomIds.size(), "C");
}

int atomIndexForId(const std::vector<std::string>& atomIds, const std::string& atomId) {
  for (std::size_t index = 0; index < atomIds.size(); ++index) {
    if (atomIds[index] == atomId) {
      return static_cast<int>(index);
    }
  }
  return -1;
}

Coordinate targetCoordinateFromRequest(const std::string& line, const Coordinate& fallback) {
  const std::string target = jsonObjectValue(line, "target");
  if (target.empty()) {
    return fallback;
  }
  const Coordinate coordinate{
      jsonDoubleValue(target, "x", fallback.x),
      jsonDoubleValue(target, "y", fallback.y),
      jsonDoubleValue(target, "z", fallback.z)};
  return std::isfinite(coordinate.x) && std::isfinite(coordinate.y) && std::isfinite(coordinate.z)
      ? coordinate
      : fallback;
}

bool allCoordinatesFinite(const std::vector<Coordinate>& coordinates) {
  for (const Coordinate& coordinate : coordinates) {
    if (!std::isfinite(coordinate.x) || !std::isfinite(coordinate.y) || !std::isfinite(coordinate.z)) {
      return false;
    }
  }
  return true;
}

void addDeterministicDepthJitter(std::vector<Coordinate>& coordinates) {
  bool hasDepth = false;
  for (const Coordinate& coordinate : coordinates) {
    if (std::fabs(coordinate.z) > 1.0e-6) {
      hasDepth = true;
      break;
    }
  }
  if (hasDepth) {
    return;
  }
  for (std::size_t index = 0; index < coordinates.size(); ++index) {
    coordinates[index].z = (static_cast<int>(index % 7) - 3) * 0.045;
  }
}

Coordinate centroidForIndices(
    const std::vector<Coordinate>& coordinates,
    const std::vector<int>& indices) {
  Coordinate centroid{0.0, 0.0, 0.0};
  if (indices.empty()) {
    return centroid;
  }
  for (const int index : indices) {
    const Coordinate& coordinate = coordinates[static_cast<std::size_t>(index)];
    centroid.x += coordinate.x;
    centroid.y += coordinate.y;
    centroid.z += coordinate.z;
  }
  const double scale = 1.0 / static_cast<double>(indices.size());
  centroid.x *= scale;
  centroid.y *= scale;
  centroid.z *= scale;
  return centroid;
}

void removeOptimizerRigidBodyDrift(
    const std::vector<Coordinate>& reference,
    std::vector<Coordinate>& coordinates,
    int draggedIndex,
    const Coordinate* draggedTarget) {
  if (reference.size() != coordinates.size() || coordinates.size() < 2) {
    if (draggedTarget != nullptr && draggedIndex >= 0 && static_cast<std::size_t>(draggedIndex) < coordinates.size()) {
      coordinates[static_cast<std::size_t>(draggedIndex)] = *draggedTarget;
    }
    return;
  }

  std::vector<int> fitIndices;
  fitIndices.reserve(coordinates.size());
  for (std::size_t index = 0; index < coordinates.size(); ++index) {
    if (static_cast<int>(index) != draggedIndex) {
      fitIndices.push_back(static_cast<int>(index));
    }
  }
  if (fitIndices.empty()) {
    if (draggedTarget != nullptr && draggedIndex >= 0 && static_cast<std::size_t>(draggedIndex) < coordinates.size()) {
      coordinates[static_cast<std::size_t>(draggedIndex)] = *draggedTarget;
    }
    return;
  }

  const Coordinate currCentroid = centroidForIndices(coordinates, fitIndices);
  const Coordinate refCentroid = centroidForIndices(reference, fitIndices);

#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
  if (fitIndices.size() >= 3) {
    Eigen::Matrix3d covariance = Eigen::Matrix3d::Zero();
    for (const int index : fitIndices) {
      const Coordinate& current = coordinates[static_cast<std::size_t>(index)];
      const Coordinate& ref = reference[static_cast<std::size_t>(index)];
      const Eigen::Vector3d currentVector(
          current.x - currCentroid.x,
          current.y - currCentroid.y,
          current.z - currCentroid.z);
      const Eigen::Vector3d refVector(
          ref.x - refCentroid.x,
          ref.y - refCentroid.y,
          ref.z - refCentroid.z);
      covariance += currentVector * refVector.transpose();
    }
    const Eigen::JacobiSVD<Eigen::Matrix3d> svd(
        covariance,
        Eigen::ComputeFullU | Eigen::ComputeFullV);
    const Eigen::Matrix3d u = svd.matrixU();
    const Eigen::Matrix3d v = svd.matrixV();
    Eigen::Matrix3d handedness = Eigen::Matrix3d::Identity();
    if ((v * u.transpose()).determinant() < 0.0) {
      handedness(2, 2) = -1.0;
    }
    const Eigen::Matrix3d rotation = v * handedness * u.transpose();
    for (Coordinate& coordinate : coordinates) {
      const Eigen::Vector3d current(
          coordinate.x - currCentroid.x,
          coordinate.y - currCentroid.y,
          coordinate.z - currCentroid.z);
      const Eigen::Vector3d aligned = rotation * current +
          Eigen::Vector3d(refCentroid.x, refCentroid.y, refCentroid.z);
      coordinate.x = aligned.x();
      coordinate.y = aligned.y();
      coordinate.z = aligned.z();
    }
  } else
#endif
  {
    const double dx = refCentroid.x - currCentroid.x;
    const double dy = refCentroid.y - currCentroid.y;
    const double dz = refCentroid.z - currCentroid.z;
    for (Coordinate& coordinate : coordinates) {
      coordinate.x += dx;
      coordinate.y += dy;
      coordinate.z += dz;
    }
  }

  if (draggedTarget != nullptr && draggedIndex >= 0 && static_cast<std::size_t>(draggedIndex) < coordinates.size()) {
    coordinates[static_cast<std::size_t>(draggedIndex)] = *draggedTarget;
  }
}

std::vector<int> graphDistances(
    std::size_t atomCount,
    const std::vector<Bond>& bonds,
    int startIndex) {
  std::vector<int> distances(atomCount, std::numeric_limits<int>::max());
  if (startIndex < 0 || static_cast<std::size_t>(startIndex) >= atomCount) {
    return distances;
  }
  distances[static_cast<std::size_t>(startIndex)] = 0;
  bool changed = true;
  while (changed) {
    changed = false;
    for (const Bond& bond : bonds) {
      if (bond.from < 0 || bond.to < 0 ||
          static_cast<std::size_t>(bond.from) >= atomCount ||
          static_cast<std::size_t>(bond.to) >= atomCount) {
        continue;
      }
      const int fromDistance = distances[static_cast<std::size_t>(bond.from)];
      const int toDistance = distances[static_cast<std::size_t>(bond.to)];
      if (fromDistance != std::numeric_limits<int>::max() &&
          fromDistance + 1 < toDistance) {
        distances[static_cast<std::size_t>(bond.to)] = fromDistance + 1;
        changed = true;
      }
      if (toDistance != std::numeric_limits<int>::max() &&
          toDistance + 1 < fromDistance) {
        distances[static_cast<std::size_t>(bond.from)] = toDistance + 1;
        changed = true;
      }
    }
  }
  return distances;
}

double graphInfluence(int graphDistance, std::size_t index, int draggedIndex) {
  if (graphDistance == 0) {
    return 1.0;
  }
  if (graphDistance == 1) {
    return 0.42;
  }
  if (graphDistance == 2) {
    return 0.18;
  }
  if (graphDistance == 3) {
    return 0.075;
  }
  if (graphDistance != std::numeric_limits<int>::max()) {
    return 0.025;
  }
  const int fallbackDistance = std::abs(static_cast<int>(index) - draggedIndex);
  return 0.08 / static_cast<double>(fallbackDistance + 1);
}

void applyProtocolScoutDrag(
    std::vector<Coordinate>& coordinates,
    const std::vector<Bond>& bonds,
    int draggedIndex,
    double dx,
    double dy) {
  if (draggedIndex < 0 || static_cast<std::size_t>(draggedIndex) >= coordinates.size()) {
    return;
  }
  const double moveX = dx;
  const double moveY = dy;
  const std::vector<int> distances = graphDistances(coordinates.size(), bonds, draggedIndex);
  for (std::size_t index = 0; index < coordinates.size(); ++index) {
    const double influence = graphInfluence(distances[index], index, draggedIndex);
    coordinates[index].x += moveX * influence;
    coordinates[index].y += moveY * influence;
    coordinates[index].z += 0.003 * influence;
  }
}

double coordinateDistance(const Coordinate& a, const Coordinate& b) {
  const double dx = a.x - b.x;
  const double dy = a.y - b.y;
  const double dz = a.z - b.z;
  return std::sqrt(dx * dx + dy * dy + dz * dz);
}

double radiusOfGyration(const std::vector<Coordinate>& coordinates) {
  if (coordinates.empty()) {
    return 0.0;
  }
  Coordinate center{0.0, 0.0, 0.0};
  for (const Coordinate& coordinate : coordinates) {
    center.x += coordinate.x;
    center.y += coordinate.y;
    center.z += coordinate.z;
  }
  const double count = static_cast<double>(coordinates.size());
  center.x /= count;
  center.y /= count;
  center.z /= count;

  double sumSquared = 0.0;
  for (const Coordinate& coordinate : coordinates) {
    const double dx = coordinate.x - center.x;
    const double dy = coordinate.y - center.y;
    const double dz = coordinate.z - center.z;
    sumSquared += dx * dx + dy * dy + dz * dz;
  }
  return std::sqrt(sumSquared / count);
}

std::vector<double> bondLengths(
    const std::vector<Coordinate>& coordinates,
    const std::vector<Bond>& bonds) {
  std::vector<double> lengths;
  lengths.reserve(bonds.size());
  for (const Bond& bond : bonds) {
    if (bond.from < 0 || bond.to < 0 ||
        static_cast<std::size_t>(bond.from) >= coordinates.size() ||
        static_cast<std::size_t>(bond.to) >= coordinates.size()) {
      lengths.push_back(0.0);
      continue;
    }
    lengths.push_back(coordinateDistance(
        coordinates[static_cast<std::size_t>(bond.from)],
        coordinates[static_cast<std::size_t>(bond.to)]));
  }
  return lengths;
}

double maxBondStretch(
    const std::vector<Coordinate>& coordinates,
    const std::vector<Bond>& bonds,
    const std::vector<double>& restLengths) {
  double maxStretch = 1.0;
  for (std::size_t bondIndex = 0; bondIndex < bonds.size(); ++bondIndex) {
    const Bond& bond = bonds[bondIndex];
    if (bond.from < 0 || bond.to < 0 ||
        static_cast<std::size_t>(bond.from) >= coordinates.size() ||
        static_cast<std::size_t>(bond.to) >= coordinates.size()) {
      continue;
    }
    const double restLength = bondIndex < restLengths.size() ? restLengths[bondIndex] : 0.0;
    if (restLength <= 0.001) {
      continue;
    }
    const double currentLength = coordinateDistance(
        coordinates[static_cast<std::size_t>(bond.from)],
        coordinates[static_cast<std::size_t>(bond.to)]);
    maxStretch = std::max(maxStretch, currentLength / restLength);
  }
  return maxStretch;
}

double minBondCompression(
    const std::vector<Coordinate>& coordinates,
    const std::vector<Bond>& bonds,
    const std::vector<double>& restLengths) {
  double minCompression = 1.0;
  for (std::size_t bondIndex = 0; bondIndex < bonds.size(); ++bondIndex) {
    const Bond& bond = bonds[bondIndex];
    if (bond.from < 0 || bond.to < 0 ||
        static_cast<std::size_t>(bond.from) >= coordinates.size() ||
        static_cast<std::size_t>(bond.to) >= coordinates.size()) {
      continue;
    }
    const double restLength = bondIndex < restLengths.size() ? restLengths[bondIndex] : 0.0;
    if (restLength <= 0.001) {
      continue;
    }
    const double currentLength = coordinateDistance(
        coordinates[static_cast<std::size_t>(bond.from)],
        coordinates[static_cast<std::size_t>(bond.to)]);
    minCompression = std::min(minCompression, currentLength / restLength);
  }
  return minCompression;
}

double maxAnchoredAtomMovement(
    const std::vector<Coordinate>& before,
    const std::vector<Coordinate>& after,
    const std::vector<bool>& mobileAtoms) {
  double maxMovement = 0.0;
  const std::size_t count = std::min(before.size(), after.size());
  for (std::size_t index = 0; index < count; ++index) {
    if (index < mobileAtoms.size() && mobileAtoms[index]) {
      continue;
    }
    maxMovement = std::max(maxMovement, coordinateDistance(before[index], after[index]));
  }
  return maxMovement;
}

bool geometryChangeIsUnsafe(
    const std::vector<Coordinate>& before,
    const std::vector<Coordinate>& after,
    const std::vector<Bond>& bonds,
    const std::vector<double>& restLengths,
    const std::vector<bool>& mobileAtoms,
    std::string& reason) {
  if (before.size() != after.size()) {
    reason = "Rejected UFF step because atom coordinates changed shape.";
    return true;
  }
  for (const Coordinate& coordinate : after) {
    if (!std::isfinite(coordinate.x) || !std::isfinite(coordinate.y) || !std::isfinite(coordinate.z)) {
      reason = "Rejected UFF step because it produced non-finite coordinates.";
      return true;
    }
  }

  const double beforeRadius = radiusOfGyration(before);
  const double afterRadius = radiusOfGyration(after);
  if (beforeRadius > 1.0 && afterRadius < beforeRadius * 0.82) {
    reason = "Rejected UFF step because it collapsed the molecule too quickly.";
    return true;
  }

  const double maxAnchoredMove = maxAnchoredAtomMovement(before, after, mobileAtoms);
  if (maxAnchoredMove > 0.05) {
    reason = "Rejected UFF step because anchored atoms moved.";
    return true;
  }

  const double maxStretch = maxBondStretch(after, bonds, restLengths);
  const double beforeMaxStretch = maxBondStretch(before, bonds, restLengths);
  const double maxAllowedStretch = std::max(3.0, beforeMaxStretch * 1.08);
  if (maxStretch > maxAllowedStretch) {
    reason = "Rejected UFF step because a bond stretched too far.";
    return true;
  }

  const double minCompression = minBondCompression(after, bonds, restLengths);
  const double beforeMinCompression = minBondCompression(before, bonds, restLengths);
  const double minAllowedCompression = std::min(0.35, beforeMinCompression * 0.92);
  if (minCompression < minAllowedCompression) {
    reason = "Rejected UFF step because bonded atoms collapsed together.";
    return true;
  }

  return false;
}

bool hasMobileAtoms(const std::vector<bool>& mobileAtoms) {
  for (const bool mobile : mobileAtoms) {
    if (mobile) {
      return true;
    }
  }
  return false;
}

std::vector<bool> allAtomsMobile(std::size_t atomCount) {
  return std::vector<bool>(atomCount, true);
}

std::vector<bool> allAtomsMobileExcept(std::size_t atomCount, int frozenAtomIndex) {
  std::vector<bool> mobileAtoms(atomCount, true);
  if (frozenAtomIndex >= 0 && static_cast<std::size_t>(frozenAtomIndex) < atomCount) {
    mobileAtoms[static_cast<std::size_t>(frozenAtomIndex)] = false;
  }
  return mobileAtoms;
}

std::vector<bool> allAtomsMobileExceptMany(std::size_t atomCount, const std::vector<int>& frozenAtomIndices) {
  std::vector<bool> mobileAtoms(atomCount, true);
  for (const int frozenAtomIndex : frozenAtomIndices) {
    if (frozenAtomIndex >= 0 && static_cast<std::size_t>(frozenAtomIndex) < atomCount) {
      mobileAtoms[static_cast<std::size_t>(frozenAtomIndex)] = false;
    }
  }
  return mobileAtoms;
}

std::vector<bool> localDragMobileAtoms(
    std::size_t atomCount,
    const std::vector<Bond>& bonds,
    int draggedIndex,
    int maxGraphDistance,
    bool includeDraggedAtom) {
  if (draggedIndex < 0 || static_cast<std::size_t>(draggedIndex) >= atomCount) {
    return allAtomsMobile(atomCount);
  }
  if (atomCount <= 12) {
    return includeDraggedAtom ? allAtomsMobile(atomCount) : allAtomsMobileExcept(atomCount, draggedIndex);
  }

  const std::vector<int> distances = graphDistances(atomCount, bonds, draggedIndex);
  std::vector<bool> mobileAtoms(atomCount, false);
  std::size_t mobileCount = 0;
  for (std::size_t index = 0; index < atomCount; ++index) {
    if (static_cast<int>(index) == draggedIndex) {
      mobileAtoms[index] = includeDraggedAtom;
      if (includeDraggedAtom) {
        ++mobileCount;
      }
      continue;
    }
    if (distances[index] != std::numeric_limits<int>::max() &&
        distances[index] <= maxGraphDistance) {
      mobileAtoms[index] = true;
      ++mobileCount;
    }
  }

  const std::size_t fixedCount = atomCount > mobileCount
      ? atomCount - mobileCount
      : 0;
  if (mobileCount < 2 || fixedCount < 3) {
    return includeDraggedAtom ? allAtomsMobile(atomCount) : allAtomsMobileExcept(atomCount, draggedIndex);
  }
  return mobileAtoms;
}

std::vector<int> dragAnchorAtomIndices(
    const std::vector<Coordinate>& coordinates,
    const std::vector<Bond>& bonds,
    int draggedIndex) {
  struct AnchorCandidate {
    int index;
    int graphDistance;
    double spatialDistance;
  };

  if (draggedIndex < 0 || static_cast<std::size_t>(draggedIndex) >= coordinates.size()) {
    return {};
  }

  const std::vector<int> graphDistance = graphDistances(coordinates.size(), bonds, draggedIndex);
  const Coordinate& dragged = coordinates[static_cast<std::size_t>(draggedIndex)];
  std::vector<AnchorCandidate> candidates;
  candidates.reserve(coordinates.size());
  for (std::size_t index = 0; index < coordinates.size(); ++index) {
    if (static_cast<int>(index) == draggedIndex) {
      continue;
    }
    const int distance = index < graphDistance.size() ? graphDistance[index] : std::numeric_limits<int>::max();
    if (distance == std::numeric_limits<int>::max()) {
      continue;
    }
    candidates.push_back({
        static_cast<int>(index),
        distance,
        coordinateDistance(dragged, coordinates[index])});
  }

  std::sort(candidates.begin(), candidates.end(), [](const AnchorCandidate& left, const AnchorCandidate& right) {
    if (left.graphDistance != right.graphDistance) {
      return left.graphDistance > right.graphDistance;
    }
    if (left.spatialDistance != right.spatialDistance) {
      return left.spatialDistance > right.spatialDistance;
    }
    return left.index < right.index;
  });

  std::vector<int> anchors;
  anchors.reserve(3);
  for (const AnchorCandidate& candidate : candidates) {
    if (anchors.size() >= 3) {
      break;
    }
    anchors.push_back(candidate.index);
  }
  return anchors;
}

std::vector<int> dragFrozenAtomIndices(
    int draggedIndex,
    const std::vector<int>& anchorAtomIndices,
    bool freezeDragged) {
  std::vector<int> frozenAtomIndices;
  frozenAtomIndices.reserve(anchorAtomIndices.size() + 1);
  if (freezeDragged) {
    frozenAtomIndices.push_back(draggedIndex);
  }
  frozenAtomIndices.insert(frozenAtomIndices.end(), anchorAtomIndices.begin(), anchorAtomIndices.end());
  return frozenAtomIndices;
}

void moveDraggedAtomToPointerTarget(
    std::vector<Coordinate>& coordinates,
    const std::vector<Coordinate>& dragStartCoordinates,
    int draggedIndex,
    double totalDeltaX,
    double totalDeltaY) {
  if (draggedIndex < 0 ||
      static_cast<std::size_t>(draggedIndex) >= coordinates.size() ||
      dragStartCoordinates.size() != coordinates.size()) {
    return;
  }
  const std::size_t index = static_cast<std::size_t>(draggedIndex);
  coordinates[index].x = dragStartCoordinates[index].x + totalDeltaX;
  coordinates[index].y = dragStartCoordinates[index].y + totalDeltaY;
  coordinates[index].z = dragStartCoordinates[index].z;
}

void clampDraggedAtomToBondReach(
    std::vector<Coordinate>& coordinates,
    const std::vector<Bond>& bonds,
    const std::vector<double>& restLengths,
    int draggedIndex,
    std::size_t passes,
    double stretchMultiplier,
    double minimumMaxLength) {
  if (draggedIndex < 0 || static_cast<std::size_t>(draggedIndex) >= coordinates.size()) {
    return;
  }

  Coordinate& dragged = coordinates[static_cast<std::size_t>(draggedIndex)];
  for (std::size_t pass = 0; pass < passes; ++pass) {
    for (std::size_t bondIndex = 0; bondIndex < bonds.size(); ++bondIndex) {
      const Bond& bond = bonds[bondIndex];
      if (bond.from != draggedIndex && bond.to != draggedIndex) {
        continue;
      }

      const int neighborIndex = bond.from == draggedIndex ? bond.to : bond.from;
      if (neighborIndex < 0 || static_cast<std::size_t>(neighborIndex) >= coordinates.size()) {
        continue;
      }

      const Coordinate& neighbor = coordinates[static_cast<std::size_t>(neighborIndex)];
      const double dx = dragged.x - neighbor.x;
      const double dy = dragged.y - neighbor.y;
      const double dz = dragged.z - neighbor.z;
      const double currentLength = std::sqrt(dx * dx + dy * dy + dz * dz);
      if (currentLength <= 0.001) {
        continue;
      }

      const double restLength = bondIndex < restLengths.size() ? restLengths[bondIndex] : 1.45;
      const double maxLength = std::max(minimumMaxLength, restLength * stretchMultiplier);
      if (currentLength <= maxLength) {
        continue;
      }

      const double scale = maxLength / currentLength;
      dragged.x = neighbor.x + dx * scale;
      dragged.y = neighbor.y + dy * scale;
      dragged.z = neighbor.z + dz * scale;
    }
  }
}

// Dev/benchmark instrumentation. Off by default so the product pays nothing: timing lines are
// emitted to stderr (protocol stays on stdout) only when CHEMDRAFT_ENGINE3D_TIMING is set, and
// the headless smoke sets it. CHEMDRAFT_ENGINE3D_NO_REUSE forces a force-field rebuild per
// optimize (the pre-reuse behavior) so the two can be A/B timed.
bool engine3dEnvFlagEnabled(const char* name) {
  const char* value = std::getenv(name);
  if (value == nullptr) {
    return false;
  }
  const std::string flag(value);
  return !(flag.empty() || flag == "0" || flag == "false" || flag == "FALSE");
}

void emitEngine3dTiming(
    bool enabled,
    const std::string& phase,
    double elapsedMs,
    std::size_t atomCount) {
  if (!enabled) {
    return;
  }
  std::ostringstream out;
  out << "[engine3d-timing] phase=" << phase
      << " ms=" << std::fixed << std::setprecision(3) << elapsedMs
      << " atoms=" << atomCount;
  std::cerr << out.str() << std::endl;
}

class AvogadroMechanics {
public:
  bool usesAvogadro() const {
#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
    return true;
#else
    return false;
#endif
  }

  // When disabled, every optimize rebuilds the molecule + force field (pre-reuse behavior).
  // Used only by the benchmark toggle; the product leaves reuse on.
  void setForceFieldReuseEnabled(bool enabled) {
#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
    m_reuseForceField = enabled;
#else
    (void)enabled;
#endif
  }

  void reset() {
#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
    m_state = Avogadro::Calc::OptimizerState{};
    // A new session means new topology; drop the cached molecule + force field so the next
    // optimize rebuilds them (see prepareForceField).
    m_uff.reset();
    m_molecule.reset();
    m_forceFieldReady = false;
    m_forceFieldAtomCount = 0;
#endif
    m_lastReport = notRunForceFieldReport();
  }

  void resetOptimizer() {
#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
    m_state = Avogadro::Calc::OptimizerState{};
#endif
  }

  const ForceFieldReport& lastReport() const {
    return m_lastReport;
  }

  ForceFieldReport optimize(
      const std::vector<std::string>& elements,
      const std::vector<Bond>& bonds,
      const std::vector<int>& formalCharges,
      std::vector<Coordinate>& coordinates,
      int frozenAtomIndex,
      std::size_t chunkIterations,
      const std::vector<bool>* mobileAtoms = nullptr) {
#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
    if (coordinates.size() < 2) {
      m_lastReport = {
          true,
          false,
          "UFF",
          "skipped",
          std::numeric_limits<double>::quiet_NaN(),
          "UFF requires at least two atoms."};
      return m_lastReport;
    }

    // Build the molecule + UFF force field once per session and reuse it. Parameter derivation
    // (atom types, bonds/angles/torsions) depends only on topology, not geometry, so rebuilding
    // it on every drag/settle step was pure waste. Reuse the cached field and only refresh the
    // molecule coordinates, the position vector, and the mobile-atom mask each call.
    if (!m_forceFieldReady || !m_reuseForceField || m_forceFieldAtomCount != coordinates.size()) {
      if (!prepareForceField(elements, bonds, formalCharges, coordinates)) {
        return m_lastReport;
      }
    } else {
      refreshMoleculeCoordinates(coordinates);
    }

    Eigen::VectorXd positions(static_cast<Eigen::Index>(coordinates.size() * 3));
    for (std::size_t index = 0; index < coordinates.size(); ++index) {
      positions[static_cast<Eigen::Index>(index * 3)] = coordinates[index].x;
      positions[static_cast<Eigen::Index>(index * 3 + 1)] = coordinates[index].y;
      positions[static_cast<Eigen::Index>(index * 3 + 2)] = coordinates[index].z;
    }

    Eigen::VectorXd mask = Eigen::VectorXd::Ones(positions.size());
    if (mobileAtoms != nullptr && mobileAtoms->size() == coordinates.size()) {
      mask.setZero();
      for (std::size_t index = 0; index < coordinates.size(); ++index) {
        if ((*mobileAtoms)[index]) {
          mask[static_cast<Eigen::Index>(index * 3)] = 1.0;
          mask[static_cast<Eigen::Index>(index * 3 + 1)] = 1.0;
          mask[static_cast<Eigen::Index>(index * 3 + 2)] = 1.0;
        }
      }
    }
    if (frozenAtomIndex >= 0 && static_cast<std::size_t>(frozenAtomIndex) < coordinates.size()) {
      mask[static_cast<Eigen::Index>(frozenAtomIndex * 3)] = 0.0;
      mask[static_cast<Eigen::Index>(frozenAtomIndex * 3 + 1)] = 0.0;
      mask[static_cast<Eigen::Index>(frozenAtomIndex * 3 + 2)] = 0.0;
    }
    m_uff->setMask(mask);

    Avogadro::Calc::OptimizationOptions options;
    options.algorithm = Avogadro::Calc::OptimizationAlgorithm::Hybrid;
    options.chunkIterations = std::max<std::size_t>(1, chunkIterations);
    options.fire.maxMove = 0.18;
    options.lbfgs.maxStep = 0.18;

    const bool optimized = Avogadro::Calc::optimizeSteps(*m_uff, positions, options, &m_state);
    if (!optimized || !positions.allFinite()) {
      m_lastReport = {
          true,
          false,
          "UFF",
          "failed",
          std::numeric_limits<double>::quiet_NaN(),
          "UFF optimization failed for the current molecule."};
      resetOptimizer();
      return m_lastReport;
    }

    for (std::size_t index = 0; index < coordinates.size(); ++index) {
      coordinates[index].x = positions[static_cast<Eigen::Index>(index * 3)];
      coordinates[index].y = positions[static_cast<Eigen::Index>(index * 3 + 1)];
      coordinates[index].z = positions[static_cast<Eigen::Index>(index * 3 + 2)];
    }

    double energy = m_state.energy;
    if (!std::isfinite(energy)) {
      energy = m_uff->evaluate(positions, nullptr);
    }
    if (std::isfinite(energy) && std::fabs(energy) > 1.0e6) {
      m_lastReport = {
          true,
          true,
          "UFF",
          "running",
          std::numeric_limits<double>::quiet_NaN(),
          "UFF energy exceeded the display range during constrained local relaxation."};
      return m_lastReport;
    }
    m_lastReport = {
        true,
        true,
        "UFF",
        std::isfinite(energy) ? "running" : "optimized",
        energy,
        ""};
    return m_lastReport;
#else
    (void)elements;
    (void)bonds;
    (void)formalCharges;
    (void)coordinates;
    (void)frozenAtomIndex;
    (void)chunkIterations;
    (void)mobileAtoms;
    m_lastReport = notRunForceFieldReport();
    return m_lastReport;
#endif
  }

private:
#ifdef CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC
  // Build the reusable molecule + UFF force field for the current topology. Returns false and
  // sets m_lastReport (leaving the cache empty) when an element is unsupported.
  bool prepareForceField(
      const std::vector<std::string>& elements,
      const std::vector<Bond>& bonds,
      const std::vector<int>& formalCharges,
      const std::vector<Coordinate>& coordinates) {
    m_uff.reset();
    m_molecule.reset();
    m_forceFieldReady = false;
    m_forceFieldAtomCount = 0;

    auto molecule = std::make_unique<Avogadro::Core::Molecule>();
    std::string unsupportedElement;
    for (std::size_t index = 0; index < coordinates.size(); ++index) {
      const std::string element = index < elements.size() ? elements[index] : "C";
      const unsigned char atomicNumber = Avogadro::Core::Elements::atomicNumberFromSymbol(element);
      if (atomicNumber == Avogadro::InvalidElement || atomicNumber == 0) {
        unsupportedElement = element;
        break;
      }
      molecule->addAtom(
          atomicNumber,
          Avogadro::Vector3(
              coordinates[index].x,
              coordinates[index].y,
              coordinates[index].z));
      if (index < formalCharges.size() && formalCharges[index] != 0) {
        const int charge = std::max(-8, std::min(8, formalCharges[index]));
        molecule->setFormalCharge(static_cast<Avogadro::Index>(index), static_cast<signed char>(charge));
      }
    }

    if (!unsupportedElement.empty()) {
      m_lastReport = {
          true,
          false,
          "UFF",
          "unsupported-element",
          std::numeric_limits<double>::quiet_NaN(),
          "UFF optimization skipped unsupported element: " + unsupportedElement};
      resetOptimizer();
      return false;
    }

    for (const Bond& bond : bonds) {
      if (bond.from < 0 || bond.to < 0 ||
          static_cast<std::size_t>(bond.from) >= coordinates.size() ||
          static_cast<std::size_t>(bond.to) >= coordinates.size()) {
        continue;
      }
      molecule->addBond(
          static_cast<Avogadro::Index>(bond.from),
          static_cast<Avogadro::Index>(bond.to),
          static_cast<unsigned char>(std::max(1, std::min(3, bond.order))));
    }

    auto uff = std::make_unique<Avogadro::Calc::UFF>();
    // setMolecule stores a raw pointer to the molecule; moving the unique_ptr afterwards keeps
    // the same heap object (and therefore that pointer) valid.
    uff->setMolecule(molecule.get());
    m_molecule = std::move(molecule);
    m_uff = std::move(uff);
    m_forceFieldAtomCount = coordinates.size();
    m_forceFieldReady = true;
    return true;
  }

  // Sync the cached molecule's atom positions to the current geometry. The optimizer works on
  // the position vector, but this keeps the molecule the UFF references consistent with it.
  void refreshMoleculeCoordinates(const std::vector<Coordinate>& coordinates) {
    if (!m_molecule) {
      return;
    }
    const std::size_t count = std::min(coordinates.size(), static_cast<std::size_t>(m_molecule->atomCount()));
    for (std::size_t index = 0; index < count; ++index) {
      m_molecule->setAtomPosition3d(
          static_cast<Avogadro::Index>(index),
          Avogadro::Vector3(
              coordinates[index].x,
              coordinates[index].y,
              coordinates[index].z));
    }
  }

  Avogadro::Calc::OptimizerState m_state;
  std::unique_ptr<Avogadro::Core::Molecule> m_molecule;
  std::unique_ptr<Avogadro::Calc::UFF> m_uff;
  bool m_forceFieldReady = false;
  bool m_reuseForceField = true;
  std::size_t m_forceFieldAtomCount = 0;
#endif
  ForceFieldReport m_lastReport = notRunForceFieldReport();
};

ForceFieldReport optimizeWithGeometryGuard(
    AvogadroMechanics& mechanics,
    const std::vector<std::string>& elements,
    const std::vector<Bond>& bonds,
    const std::vector<int>& formalCharges,
    std::vector<Coordinate>& coordinates,
    const std::vector<double>& restLengths,
    int frozenAtomIndex,
    std::size_t chunkIterations,
    const std::vector<bool>& mobileAtoms) {
  const std::vector<Coordinate> before = coordinates;
  ForceFieldReport report = mechanics.optimize(
      elements,
      bonds,
      formalCharges,
      coordinates,
      frozenAtomIndex,
      chunkIterations,
      &mobileAtoms);
  if (!report.ok) {
    return report;
  }

  std::string reason;
  if (geometryChangeIsUnsafe(before, coordinates, bonds, restLengths, mobileAtoms, reason)) {
    coordinates = before;
    mechanics.resetOptimizer();
    report.status = "guarded";
    report.warning = reason;
  }
  return report;
}

ForceFieldReport optimizeMobileAtoms(
    AvogadroMechanics& mechanics,
    const std::vector<std::string>& elements,
    const std::vector<Bond>& bonds,
    const std::vector<int>& formalCharges,
    std::vector<Coordinate>& coordinates,
    const std::vector<double>& restLengths,
    int frozenAtomIndex,
    const std::vector<bool>& mobileAtoms,
    std::size_t maxPasses,
    std::size_t chunkIterations) {
  ForceFieldReport report = mechanics.lastReport();
  if (!mechanics.usesAvogadro() || !hasMobileAtoms(mobileAtoms)) {
    return report;
  }
  for (std::size_t pass = 0; pass < maxPasses; ++pass) {
    report = optimizeWithGeometryGuard(
        mechanics,
        elements,
        bonds,
        formalCharges,
        coordinates,
        restLengths,
        frozenAtomIndex,
        chunkIterations,
        mobileAtoms);
    if (!report.ok) {
      break;
    }
  }
  return report;
}

int runStdio() {
  std::string activeSession = "engine3d-session-1";
  std::string graphSignature;
  std::string bondSignature;
  unsigned int coordinateRevision = 0;
  std::vector<std::string> atomIds;
  std::vector<std::string> elements;
  std::vector<Coordinate> coordinates;
  std::vector<Bond> bonds;
  std::vector<int> formalCharges;
  std::vector<double> restBondLengths;
  AvogadroMechanics mechanics;
  const bool timingEnabled = engine3dEnvFlagEnabled("CHEMDRAFT_ENGINE3D_TIMING");
  mechanics.setForceFieldReuseEnabled(!engine3dEnvFlagEnabled("CHEMDRAFT_ENGINE3D_NO_REUSE"));
  ForceFieldReport forceField = mechanics.lastReport();
  int draggedAtomIndex = -1;
  std::vector<Coordinate> dragReferenceCoordinates;
  Coordinate draggedAtomTarget{0.0, 0.0, 0.0};

  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string id = requestId(line);
    const std::string type = jsonStringValue(line, "type");
    const std::string session = sessionId(line, activeSession);

    if (type == "createSession") {
      graphSignature = jsonStringValue(line, "graphSignature");
      bondSignature = jsonStringValue(line, "bondSignature");
      atomIds = jsonStringArrayValue(line, "atomIdByMolfileIndex");
      const MolfileGeometry geometry = parseMolfileGeometry(jsonStringValue(line, "molfile"), atomIds);
      const std::vector<Coordinate> initialCoordinates = coords3dByAtomIdValue(line, atomIds);
      coordinates = initialCoordinates.empty()
          ? (geometry.coordinates.empty() ? defaultCoordinatesForAtoms(atomIds) : geometry.coordinates)
          : initialCoordinates;
      elements = geometry.elements.empty() ? defaultElementsForAtoms(atomIds) : geometry.elements;
      bonds = geometry.bonds;
      formalCharges = geometry.formalCharges;
      if (coordinates.size() < atomIds.size()) {
        const std::vector<Coordinate> fallback = defaultCoordinatesForAtoms(atomIds);
        coordinates.insert(coordinates.end(), fallback.begin() + static_cast<long>(coordinates.size()), fallback.end());
      }
      if (elements.size() < atomIds.size()) {
        elements.resize(atomIds.size(), "C");
      }
      if (formalCharges.size() < atomIds.size()) {
        formalCharges.resize(atomIds.size(), 0);
      }
      addDeterministicDepthJitter(coordinates);
      restBondLengths = bondLengths(coordinates, bonds);
      dragReferenceCoordinates.clear();
      draggedAtomIndex = atomIds.empty() ? -1 : 0;
      mechanics.reset();
      forceField = mechanics.lastReport();
      activeSession = session;
      emitOk(id, activeSession, "{\"sessionId\":\"" + activeSession + "\"}");
      emitReadyEvent(id, activeSession, atomIds, coordinates);
      emitCoordinatesChanged(id, activeSession, coordinateRevision, atomIds, coordinates, "embed");
      if (mechanics.usesAvogadro()) {
        const auto relaxStart = std::chrono::steady_clock::now();
        forceField = mechanics.optimize(elements, bonds, formalCharges, coordinates, -1, 18);
        emitEngine3dTiming(
            timingEnabled,
            "initial-relax",
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - relaxStart).count(),
            coordinates.size());
        if (!allCoordinatesFinite(coordinates)) {
          coordinates = initialCoordinates.empty()
              ? (geometry.coordinates.empty() ? defaultCoordinatesForAtoms(atomIds) : geometry.coordinates)
              : initialCoordinates;
          addDeterministicDepthJitter(coordinates);
          forceField = notRunForceFieldReport();
        } else {
          ++coordinateRevision;
          emitCoordinatesChanged(id, activeSession, coordinateRevision, atomIds, coordinates, "initial-relax");
        }
      }
      emitEnergyChanged(id, activeSession, forceField);
    } else if (type == "ping") {
      emitOk(id, session);
      emitEvent(id, session, "heartbeat");
    } else if (type == "beginDrag") {
      const std::string atomId = jsonStringValue(line, "atomId");
      draggedAtomIndex = atomIndexForId(atomIds, atomId);
      if (draggedAtomIndex < 0) {
        emitError(id, session, "Unknown dragged atom id.");
        continue;
      }
      draggedAtomTarget = coordinates[static_cast<std::size_t>(draggedAtomIndex)];
      mechanics.resetOptimizer();
      dragReferenceCoordinates = coordinates;
      emitOk(id, session, "{\"draggedAtomId\":\"" + jsonEscape(atomId) + "\"}");
      std::cout << "{\"protocolVersion\":" << kProtocolVersion
                << ",\"requestId\":\"" << id << ".event\",\"sessionId\":\"" << session
                << "\",\"type\":\"event\",\"eventType\":\"selectionChanged\","
                << "\"selectedAtomIds\":" << selectedAtomIdsJson(atomIds, draggedAtomIndex) << "}" << std::endl;
    } else if (type == "updateDrag") {
      const std::string atomId = jsonStringValue(line, "atomId");
      const int requestedDragIndex = atomIndexForId(atomIds, atomId);
      if (requestedDragIndex < 0) {
        emitError(id, session, "Unknown dragged atom id.");
        continue;
      }
      draggedAtomIndex = requestedDragIndex;
      const Coordinate target = targetCoordinateFromRequest(
          line,
          coordinates[static_cast<std::size_t>(draggedAtomIndex)]);
      const std::vector<Coordinate> reference = dragReferenceCoordinates.size() == coordinates.size()
          ? dragReferenceCoordinates
          : coordinates;
      coordinates[static_cast<std::size_t>(draggedAtomIndex)] = target;
      clampDraggedAtomToBondReach(
          coordinates,
          bonds,
          restBondLengths,
          draggedAtomIndex,
          4,
          2.05,
          2.55);
      const Coordinate constrainedTarget = coordinates[static_cast<std::size_t>(draggedAtomIndex)];
      draggedAtomTarget = constrainedTarget;
      ++coordinateRevision;
      if (mechanics.usesAvogadro()) {
        mechanics.resetOptimizer();
        const std::vector<bool> mobileAtoms = localDragMobileAtoms(
            coordinates.size(),
            bonds,
            draggedAtomIndex,
            4,
            false);
        const auto dragStart = std::chrono::steady_clock::now();
        forceField = optimizeWithGeometryGuard(
            mechanics,
            elements,
            bonds,
            formalCharges,
            coordinates,
            restBondLengths,
            draggedAtomIndex,
            3,
            mobileAtoms);
        emitEngine3dTiming(
            timingEnabled,
            "updateDrag",
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - dragStart).count(),
            coordinates.size());
        if (!forceField.ok || !allCoordinatesFinite(coordinates)) {
          coordinates = reference;
          coordinates[static_cast<std::size_t>(draggedAtomIndex)] = constrainedTarget;
        } else {
          removeOptimizerRigidBodyDrift(reference, coordinates, draggedAtomIndex, &constrainedTarget);
        }
      } else {
        applyProtocolScoutDrag(coordinates, bonds, draggedAtomIndex, constrainedTarget.x - reference[static_cast<std::size_t>(draggedAtomIndex)].x, constrainedTarget.y - reference[static_cast<std::size_t>(draggedAtomIndex)].y);
        coordinates[static_cast<std::size_t>(draggedAtomIndex)] = constrainedTarget;
        forceField = mechanics.lastReport();
      }
      emitOk(id, session);
      emitCoordinatesChanged(id, session, coordinateRevision, atomIds, coordinates, "drag");
      emitEnergyChanged(id, session, forceField);
    } else if (type == "endDrag") {
      const std::string atomId = jsonStringValue(line, "atomId");
      const int requestedDragIndex = atomIndexForId(atomIds, atomId);
      if (requestedDragIndex < 0) {
        emitError(id, session, "Unknown dragged atom id.");
        continue;
      }
      draggedAtomIndex = requestedDragIndex;
      clampDraggedAtomToBondReach(
          coordinates,
          bonds,
          restBondLengths,
          draggedAtomIndex,
          4,
          2.05,
          2.55);
      const std::vector<Coordinate> reference = dragReferenceCoordinates.size() == coordinates.size()
          ? dragReferenceCoordinates
          : coordinates;
      if (mechanics.usesAvogadro()) {
        mechanics.resetOptimizer();
        const std::vector<bool> mobileAtoms = localDragMobileAtoms(
            coordinates.size(),
            bonds,
            draggedAtomIndex,
            5,
            true);
        const auto settleStart = std::chrono::steady_clock::now();
        forceField = optimizeMobileAtoms(
            mechanics,
            elements,
            bonds,
            formalCharges,
            coordinates,
            restBondLengths,
            -1,
            mobileAtoms,
            8,
            12);
        emitEngine3dTiming(
            timingEnabled,
            "endDrag-settle",
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - settleStart).count(),
            coordinates.size());
        if (!forceField.ok || !allCoordinatesFinite(coordinates)) {
          coordinates = reference;
        } else {
          clampDraggedAtomToBondReach(
              coordinates,
              bonds,
              restBondLengths,
              draggedAtomIndex,
              3,
              1.28,
              1.72);
          removeOptimizerRigidBodyDrift(reference, coordinates, draggedAtomIndex, nullptr);
        }
      }
      ++coordinateRevision;
      emitOk(id, session);
      emitCoordinatesChanged(id, session, coordinateRevision, atomIds, coordinates, "settle");
      emitEnergyChanged(id, session, forceField);
      dragReferenceCoordinates.clear();
    } else if (type == "commit") {
      emitCommit(id, session, coordinateRevision, graphSignature, bondSignature, atomIds, coordinates, forceField);
    } else if (type == "dispose") {
      emitOk(id, session);
      emitEvent(id, session, "closed");
      dragReferenceCoordinates.clear();
    } else {
      emitError(id, session, "Unknown interactive 3D request type.");
    }
  }

  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--stdio") {
    return runStdio();
  }

  std::cerr << "Usage: avogadro3d-sidecar --stdio" << std::endl;
  return 2;
}
