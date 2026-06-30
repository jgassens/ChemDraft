cmake_minimum_required(VERSION 3.24)

project(avogadro3d-sidecar LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT
    "416651ddaef33a4e20392392e7c0b505d446491b"
    CACHE STRING "Pinned OpenChemistry/avogadrolibs commit for the interactive 3D sidecar")

option(CHEMDRAFT_AVOGADRO3D_USE_QT "Enable Qt 6 offscreen rendering integration" ON)
option(CHEMDRAFT_AVOGADRO3D_USE_OPENGL "Enable OpenGL rendering support" ON)
option(CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC "Link Avogadro Core/Calc for BSD UFF optimization" OFF)
option(CHEMDRAFT_AVOGADRO3D_ENABLE_DIAGNOSTIC_VIEWPORT "Allow dev-only sidecar-owned Qt viewport" OFF)
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

if(CHEMDRAFT_AVOGADRO3D_ENABLE_DIAGNOSTIC_VIEWPORT)
  message(STATUS "Dev-only diagnostic Qt viewport is enabled; this must not be shipped as product UI.")
endif()

add_executable(avogadro3d-sidecar src/main.cpp)
target_compile_definitions(avogadro3d-sidecar PRIVATE
  CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT="${CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT}"
)

if(CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC)
  set(_chemdraft_avogadro_source "${CMAKE_CURRENT_SOURCE_DIR}/_deps/avogadrolibs")
  if(NOT EXISTS "${_chemdraft_avogadro_source}/CMakeLists.txt")
    message(FATAL_ERROR
      "CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC requires "
      "native/avogadro3d-sidecar/_deps/avogadrolibs at "
      "${CHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT}.")
  endif()

  set(_chemdraft_eigen_source "${CMAKE_CURRENT_SOURCE_DIR}/_deps/eigen")
  if(EXISTS "${_chemdraft_eigen_source}/Eigen/Core")
    set(_chemdraft_eigen_config_dir "${CMAKE_CURRENT_BINARY_DIR}/cmake/eigen3")
    file(MAKE_DIRECTORY "${_chemdraft_eigen_config_dir}")
    file(WRITE "${_chemdraft_eigen_config_dir}/Eigen3Config.cmake"
      "if(NOT TARGET Eigen3::Eigen)\n"
      "  add_library(Eigen3::Eigen INTERFACE IMPORTED)\n"
      "  set_target_properties(Eigen3::Eigen PROPERTIES INTERFACE_INCLUDE_DIRECTORIES \"${_chemdraft_eigen_source}\")\n"
      "endif()\n"
      "set(Eigen3_FOUND TRUE)\n"
      "set(EIGEN3_INCLUDE_DIR \"${_chemdraft_eigen_source}\")\n"
      "set(EIGEN3_VERSION_STRING \"3.4.0\")\n")
    set(Eigen3_DIR "${_chemdraft_eigen_config_dir}" CACHE PATH "Local Eigen3 config" FORCE)
  endif()

  set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build avogadrolibs as static libraries" FORCE)
  set(ENABLE_TESTING OFF CACHE BOOL "Disable avogadrolibs tests" FORCE)
  set(ENABLE_CALC_BENCHMARKS OFF CACHE BOOL "Disable avogadrolibs calc benchmarks" FORCE)
  set(USE_QT OFF CACHE BOOL "Disable avogadrolibs Qt libraries for mechanics slice" FORCE)
  set(USE_OPENGL OFF CACHE BOOL "Disable avogadrolibs OpenGL libraries for mechanics slice" FORCE)
  set(USE_HDF5 OFF CACHE BOOL "Disable avogadrolibs HDF5 features" FORCE)
  set(USE_LIBARCHIVE OFF CACHE BOOL "Disable avogadrolibs libarchive features" FORCE)
  set(USE_LIBMSYM OFF CACHE BOOL "Disable avogadrolibs libmsym features" FORCE)
  set(USE_MMTF OFF CACHE BOOL "Disable avogadrolibs MMTF features" FORCE)
  set(USE_PLOTTER OFF CACHE BOOL "Disable avogadrolibs plotter features" FORCE)
  set(USE_PYTHON OFF CACHE BOOL "Disable avogadrolibs Python wrapping" FORCE)
  set(USE_SPGLIB OFF CACHE BOOL "Disable avogadrolibs spglib features" FORCE)
  set(SKBUILD ON CACHE BOOL "Skip avogadrolibs command/install extras in sidecar build" FORCE)

  add_subdirectory("${_chemdraft_avogadro_source}" "${CMAKE_CURRENT_BINARY_DIR}/avogadrolibs" EXCLUDE_FROM_ALL)
  target_link_libraries(avogadro3d-sidecar PRIVATE Avogadro::Core Avogadro::Calc)
  target_compile_definitions(avogadro3d-sidecar PRIVATE CHEMDRAFT_AVOGADRO3D_USE_AVOGADRO_CALC=1)
endif()

install(TARGETS avogadro3d-sidecar RUNTIME DESTINATION bin)
