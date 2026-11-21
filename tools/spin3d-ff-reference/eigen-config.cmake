# SPDX-License-Identifier: Apache-2.0

# The generated CMake source would interpret native Windows separators as escapes.
string(REPLACE "\\" "/" EIGEN_SOURCE "${EIGEN_SOURCE}")
set(eigen_config_dir "${CMAKE_CURRENT_BINARY_DIR}/eigen3")
file(MAKE_DIRECTORY "${eigen_config_dir}")
file(CONFIGURE OUTPUT "${eigen_config_dir}/Eigen3Config.cmake" CONTENT [=[
if(NOT TARGET Eigen3::Eigen)
  add_library(Eigen3::Eigen INTERFACE IMPORTED)
  set_target_properties(Eigen3::Eigen PROPERTIES INTERFACE_INCLUDE_DIRECTORIES [==[@EIGEN_SOURCE@]==])
endif()
set(Eigen3_FOUND TRUE)
set(EIGEN3_INCLUDE_DIR [==[@EIGEN_SOURCE@]==])
set(EIGEN3_VERSION_STRING "3.4.0")
]=] @ONLY)
set(Eigen3_DIR "${eigen_config_dir}" CACHE PATH "Local Eigen 3 config" FORCE)
