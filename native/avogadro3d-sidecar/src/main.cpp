#include <iostream>
#include <string>

namespace {

constexpr int kProtocolVersion = 1;

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
  const std::size_t endQuote = json.find('"', startQuote + 1);
  if (endQuote == std::string::npos) {
    return "";
  }
  return json.substr(startQuote + 1, endQuote - startQuote - 1);
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

void emitOk(const std::string& id, const std::string& session) {
  std::cout << responsePrefix(id, session) << ",\"ok\":true}" << std::endl;
}

void emitError(const std::string& id, const std::string& session, const std::string& message) {
  std::cout << responsePrefix(id, session)
            << ",\"ok\":false,\"error\":\"" << message << "\"}" << std::endl;
}

void emitReady() {
  std::cout
      << "{\"protocolVersion\":" << kProtocolVersion
      << ",\"requestId\":\"startup\",\"type\":\"event\",\"event\":\"ready\","
      << "\"engine\":{\"name\":\"avogadro3d-sidecar\",\"version\":\"protocol-scout\","
      << "\"avogadroCommit\":\"" << CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT << "\"}}"
      << std::endl;
}

void emitEvent(const std::string& id, const std::string& session, const std::string& event) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion << ",\"requestId\":\"" << id
            << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"event\":\"" << event << "\"}" << std::endl;
}

void emitEnergyChanged(const std::string& id, const std::string& session) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion << ",\"requestId\":\"" << id
            << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"event\":\"energyChanged\",\"energy\":{\"value\":0,"
            << "\"unit\":\"kJ/mol\",\"label\":\"protocol scout\"}}" << std::endl;
}

void emitCoordinatesChanged(
    const std::string& id,
    const std::string& session,
    unsigned int coordinateRevision) {
  std::cout << "{\"protocolVersion\":" << kProtocolVersion << ",\"requestId\":\"" << id
            << ".event\",\"sessionId\":\"" << session
            << "\",\"type\":\"event\",\"event\":\"coordinatesChanged\","
            << "\"coordinateRevision\":" << coordinateRevision
            << ",\"coords3dByAtomId\":{}}" << std::endl;
}

void emitCommit(
    const std::string& id,
    const std::string& session,
    unsigned int coordinateRevision,
    const std::string& graphSignature,
    const std::string& bondSignature) {
  std::cout << responsePrefix(id, session)
            << ",\"ok\":true,\"result\":{\"coords3dByAtomId\":{},"
            << "\"coordinateRevision\":" << coordinateRevision
            << ",\"graphSignature\":\"" << graphSignature
            << "\",\"bondSignature\":\"" << bondSignature
            << "\",\"camera\":{\"projection\":\"perspective\","
            << "\"viewMatrix\":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},"
            << "\"engine\":{\"name\":\"avogadro3d-sidecar\",\"version\":\"protocol-scout\","
            << "\"avogadroCommit\":\"" << CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT << "\"},"
            << "\"forceField\":{\"name\":\"avogadro-placeholder\",\"status\":\"not-linked\"},"
            << "\"warnings\":[\"Avogadro libraries are not linked in this protocol scout build.\"]}}"
            << std::endl;
}

int runStdio() {
  std::string activeSession = "engine3d-session-1";
  std::string graphSignature;
  std::string bondSignature;
  unsigned int coordinateRevision = 0;

  emitReady();

  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string id = requestId(line);
    const std::string type = jsonStringValue(line, "type");
    const std::string session = sessionId(line, activeSession);

    if (type == "createSession") {
      graphSignature = jsonStringValue(line, "graphSignature");
      bondSignature = jsonStringValue(line, "bondSignature");
      activeSession = session;
      emitOk(id, activeSession);
      emitEvent(id, activeSession, "ready");
    } else if (type == "showViewport") {
      emitOk(id, session);
      emitEvent(id, session, "viewportShown");
    } else if (type == "startAutoOptimize") {
      emitOk(id, session);
      emitEnergyChanged(id, session);
    } else if (type == "stopAutoOptimize" || type == "hideViewport" ||
               type == "setCamera" || type == "ping") {
      emitOk(id, session);
    } else if (type == "pointer") {
      ++coordinateRevision;
      emitOk(id, session);
      emitCoordinatesChanged(id, session, coordinateRevision);
    } else if (type == "commit") {
      emitCommit(id, session, coordinateRevision, graphSignature, bondSignature);
    } else if (type == "dispose") {
      emitOk(id, session);
      emitEvent(id, session, "closed");
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
