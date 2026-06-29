cmake_minimum_required(VERSION 3.24)

project(avogadro3d-sidecar LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT
    "416651ddaef33a4e20392392e7c0b505d446491b"
    CACHE STRING "Pinned OpenChemistry/avogadrolibs commit for the interactive 3D sidecar")

option(CHEMDRAFT_AVOGADRO3D_USE_QT "Enable Qt 6 viewport integration" ON)
option(CHEMDRAFT_AVOGADRO3D_USE_OPENGL "Enable OpenGL rendering support" ON)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_OPENBABEL "Allow Open Babel linkage" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_GPL_PLUGINS "Allow GPL plugin linkage" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_PYTHON "Allow Python embedding" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_TESTS "Build sidecar native tests" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_BENCHMARKS "Build sidecar benchmarks" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_PLOTTER "Allow plotter support" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_LIBARCHIVE "Allow libarchive support" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_LIBMSYM "Allow libmsym support" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_SPGLIB "Allow spglib support" OFF)

if(CHEMDRAFT_AVOGADRO3D_ENABLE_OPENBABEL)
  message(FATAL_ERROR "Milestone 1 sidecar must not link Open Babel.")
endif()

if(CHEMDRAFT_AVOGADRO3D_ENABLE_GPL_PLUGINS)
  message(FATAL_ERROR "Milestone 1 sidecar must not link GPL plugins.")
endif()

add_executable(avogadro3d-sidecar src/main.cpp)
target_compile_definitions(avogadro3d-sidecar PRIVATE
  CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT="${CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT}"
)

install(TARGETS avogadro3d-sidecar RUNTIME DESTINATION bin)
