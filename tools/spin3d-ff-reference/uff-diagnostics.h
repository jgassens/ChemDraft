// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <avogadro/calc/uff.h>
#include <nlohmann/json.hpp>

class DiagnosticUff : public Avogadro::Calc::UFF
{
public:
  nlohmann::json topology() const;
};
