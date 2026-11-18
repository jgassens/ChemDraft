# SPDX-License-Identifier: Apache-2.0
cmake_minimum_required(VERSION 3.24)
project(Spin3dUffReference LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

string(REPLACE "\\" "/" AVOGADROLIBS_SOURCE "${AVOGADROLIBS_SOURCE}")
if(NOT EXISTS "${AVOGADROLIBS_SOURCE}/avogadro/calc/uff.cpp")
  message(FATAL_ERROR "Set AVOGADROLIBS_SOURCE to the pinned Avogadrolibs checkout.")
endif()

include(eigen-config.cmake)
if(NOT EXISTS "${EIGEN_SOURCE}/Eigen/Core")
  message(FATAL_ERROR "Set EIGEN_SOURCE to the Eigen 3.4.0 source directory.")
endif()

# Match the sidecar's offline Core/Calc build.
set(disabled_options
  BUILD_SHARED_LIBS BUILD_DOCUMENTATION ENABLE_TESTING ENABLE_CALC_BENCHMARKS
  USE_QT USE_OPENGL USE_HDF5 USE_LIBARCHIVE USE_LIBMSYM USE_MMTF USE_PLOTTER USE_PYTHON
  USE_SPGLIB USE_EXTERNAL_NLOHMANN USE_EXTERNAL_PUGIXML USE_EXTERNAL_STRUCT USE_EXTERNAL_TOMLPLUSPLUS)
set(build_options "EIGEN_MPL2_ONLY=ON\nSKBUILD=ON\n")
foreach(option IN LISTS disabled_options)
  set(${option} OFF CACHE BOOL "Disabled for the offline UFF reference" FORCE)
  string(APPEND build_options "${option}=OFF\n")
endforeach()
set(SKBUILD ON CACHE BOOL "Skip Avogadrolibs installation extras" FORCE)
add_compile_definitions(EIGEN_MPL2_ONLY)
if(MSVC)
  add_compile_definitions(_USE_MATH_DEFINES NOMINMAX _CRT_SECURE_NO_WARNINGS)
  add_compile_options(/bigobj /utf-8 /EHsc)
  set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
  string(APPEND build_options
    "msvcOptions=/bigobj /utf-8 /EHsc /MT\nmsvcDefinitions=_USE_MATH_DEFINES NOMINMAX _CRT_SECURE_NO_WARNINGS\n")
endif()

add_subdirectory("${AVOGADROLIBS_SOURCE}" avogadrolibs EXCLUDE_FROM_ALL)

# The diagnostic executable supplies its own UFF translation unit. The static
# archive supplies the remaining Calc objects to both executables.
set(upstream_uff "${AVOGADROLIBS_SOURCE}/avogadro/calc/uff.cpp")
set(diagnostic_code "${CMAKE_CURRENT_SOURCE_DIR}/uff-diagnostics.inc")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${upstream_uff}" "${diagnostic_code}")
file(READ "${upstream_uff}" uff_source)
file(READ "${diagnostic_code}" diagnostics)
set(diagnostic_uff "${CMAKE_CURRENT_BINARY_DIR}/uff-diagnostic.cpp")
file(CONFIGURE OUTPUT "${diagnostic_uff}" CONTENT "@uff_source@\n@diagnostics@" @ONLY)

add_executable(uff-reference harness.cpp)
add_executable(uff-reference-diagnostic harness.cpp "${diagnostic_uff}")
target_compile_definitions(uff-reference-diagnostic PRIVATE UFF_REFERENCE_DIAGNOSTICS)
target_include_directories(uff-reference-diagnostic PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${AVOGADROLIBS_SOURCE}/avogadro/calc"
  "${CMAKE_CURRENT_BINARY_DIR}/avogadrolibs/avogadro/calc")
foreach(target IN ITEMS uff-reference uff-reference-diagnostic)
  target_link_libraries(${target} PRIVATE Avogadro::Calc Avogadro::Core nlohmann_json::nlohmann_json)
endforeach()

# Report actual L-BFGS iterations without changing the pinned solver or the
# pristine fixture targets. The pin otherwise discards the solver progress.
set(upstream_optimizer "${AVOGADROLIBS_SOURCE}/avogadro/calc/energyoptimizer.cpp")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${upstream_optimizer}")
file(READ "${upstream_optimizer}" optimizer_source)
string(REPLACE "\r\n" "\n" optimizer_source "${optimizer_source}")
set(progress_discard "  (void)solverProgress;")
set(lbfgs_solve "  auto [solution, solverProgress] = solver.Minimize(objective, initialState);")
set(fire_step "    positions += dr;\n    lastEnergy = method.evaluate(positions, &grad);")
foreach(marker IN ITEMS progress_discard lbfgs_solve fire_step)
  string(FIND "${optimizer_source}" "${${marker}}" position)
  if(position EQUAL -1)
    message(FATAL_ERROR "Missing optimizer instrumentation marker: ${marker}")
  endif()
endforeach()
string(REPLACE "${lbfgs_solve}" [=[
  if (Spin3dBenchmark::acceptedStepObserver) {
    solver.SetCallback([](const auto&, const auto& accepted, const auto& progress) {
      if (progress.num_iterations > 0)
        Spin3dBenchmark::acceptedStepObserver(accepted.x, accepted.value, progress.num_iterations);
    });
  }
  auto [solution, solverProgress] = solver.Minimize(objective, initialState);]=]
  optimizer_source "${optimizer_source}")
string(REPLACE "${fire_step}" "${fire_step}
    if (Spin3dBenchmark::acceptedStepObserver)
      Spin3dBenchmark::acceptedStepObserver(positions, lastEnergy, step + 1);"
  optimizer_source "${optimizer_source}")
string(REPLACE "${progress_discard}"
  "  Spin3dBenchmark::recordLbfgsIterations(solverProgress.num_iterations);"
  optimizer_source "${optimizer_source}")
set(counted_optimizer "${CMAKE_CURRENT_BINARY_DIR}/energyoptimizer-counted.cpp")
file(CONFIGURE OUTPUT "${counted_optimizer}" CONTENT
"#include \"optimizer-observer.h\"
@optimizer_source@" @ONLY)
add_executable(optimizer-benchmark optimizer-benchmark.cpp "${counted_optimizer}")
set_target_properties(optimizer-benchmark PROPERTIES
  CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
target_include_directories(optimizer-benchmark PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${AVOGADROLIBS_SOURCE}/avogadro/calc"
  "${CMAKE_CURRENT_BINARY_DIR}/avogadrolibs/avogadro/calc")
target_link_libraries(optimizer-benchmark PRIVATE Avogadro::Calc Avogadro::Core
  nlohmann_json::nlohmann_json cppoptlib)
file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/optimizer-benchmark-$<CONFIG>.txt"
  CONTENT "$<TARGET_FILE:optimizer-benchmark>\ncxxVisibilityPreset=hidden\nvisibilityInlinesHidden=ON\n")

# Let CMake resolve executable paths for single- and multi-config generators.
get_directory_property(upstream_flags DIRECTORY "${AVOGADROLIBS_SOURCE}" DEFINITION CMAKE_CXX_FLAGS)
get_directory_property(upstream_release_flags DIRECTORY "${AVOGADROLIBS_SOURCE}"
  DEFINITION CMAKE_CXX_FLAGS_RELEASE)
file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/metadata-$<CONFIG>.txt" CONTENT
"$<TARGET_FILE:uff-reference>
$<TARGET_FILE:uff-reference-diagnostic>
compiler=${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}
cmake=${CMAKE_VERSION}
generator=${CMAKE_GENERATOR}
system=${CMAKE_SYSTEM_NAME}
arch=${CMAKE_SYSTEM_PROCESSOR}
configuration=$<CONFIG>
cxxStandard=${CMAKE_CXX_STANDARD}
cxxExtensions=${CMAKE_CXX_EXTENSIONS}
cxxFlags=${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_RELEASE}
avogadroCxxFlags=${upstream_flags} ${upstream_release_flags}
osxArchitectures=${CMAKE_OSX_ARCHITECTURES}
osxDeploymentTarget=${CMAKE_OSX_DEPLOYMENT_TARGET}
${build_options}")
