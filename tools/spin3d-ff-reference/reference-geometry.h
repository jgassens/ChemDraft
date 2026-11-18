// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <avogadro/core/atom.h>
#include <avogadro/core/bond.h>
#include <avogadro/core/molecule.h>
#include <nlohmann/json.hpp>

#include <array>
#include <stdexcept>

namespace Spin3dReference {
using Avogadro::Core::Molecule;
using Eigen::VectorXd;
using nlohmann::json;

inline void setPositions(Molecule& molecule, const VectorXd& x)
{
  for (size_t i = 0; i < molecule.atomCount(); ++i)
    molecule.atom(i).setPosition3d(x.segment<3>(3 * i));
}

inline void checkScanLimitGeometry(const json& bonds, const VectorXd& x)
{
  // The pin leaves row -1 for Z > 100. Bonded and vdW setup would dereference
  // that row. Only probe scan coverage in isolated, static, far-apart graphs.
  if (!bonds.empty())
    throw std::runtime_error("Scan-limit atoms must be unbonded");
  for (Eigen::Index i = 0; i < x.size(); i += 3) {
    for (Eigen::Index j = i + 3; j < x.size(); j += 3) {
      if ((x.segment<3>(i) - x.segment<3>(j)).squaredNorm() <= 121)
        throw std::runtime_error("Scan-limit atoms must stay beyond the vdW cutoff");
    }
  }
}

struct Geometry
{
  Molecule molecule;
  VectorXd positions;
  bool probesScanLimit = false;

  Geometry(const json& atoms, const json& bonds, const json& coordinates)
    : positions(3 * atoms.size())
  {
    if (atoms.empty() || coordinates.size() != atoms.size())
      throw std::runtime_error("Expected one coordinate triple per atom");
    for (size_t i = 0; i < atoms.size(); ++i) {
      const auto xyz = coordinates.at(i).get<std::array<double, 3>>();
      positions.segment<3>(3 * i) = Eigen::Vector3d(xyz[0], xyz[1], xyz[2]);
      const int z = atoms[i].at("atomicNumber").get<int>();
      const int charge = atoms[i].at("formalCharge").get<int>();
      if (z <= 0 || z > 103 || charge < -128 || charge > 127)
        throw std::runtime_error("Atom lies outside the pinned oracle's safe input range");
      probesScanLimit = probesScanLimit || z > 100;
      if (!molecule.addAtom(static_cast<unsigned char>(z)).isValid() ||
          !molecule.setFormalCharge(i, static_cast<signed char>(charge)))
        throw std::runtime_error("Avogadro rejected an atom or its charge");
    }
    if (probesScanLimit)
      checkScanLimitGeometry(bonds, positions);
    for (const auto& bond : bonds) {
      const size_t a = bond.at("a").get<size_t>();
      const size_t b = bond.at("b").get<size_t>();
      const int order = bond.at("order").get<int>();
      if (a >= atoms.size() || b >= atoms.size() || a == b || order < 1 || order > 3 ||
          !molecule.addBond(a, b, static_cast<unsigned char>(order)).isValid())
        throw std::runtime_error("Avogadro rejected a bond");
    }
    setPositions(molecule, positions);
  }
};
} // namespace Spin3dReference
