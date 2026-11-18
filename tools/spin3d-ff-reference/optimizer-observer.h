// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <Eigen/Core>

#include <cstddef>

namespace Spin3dBenchmark {
using AcceptedStepObserver = void (*)(const Eigen::VectorXd&, double, std::size_t);
extern AcceptedStepObserver acceptedStepObserver;
void recordLbfgsIterations(std::size_t iterations);
} // namespace Spin3dBenchmark
