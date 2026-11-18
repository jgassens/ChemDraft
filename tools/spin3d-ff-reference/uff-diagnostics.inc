// SPDX-License-Identifier: Apache-2.0
// Appended to a build-directory copy of Avogadro's upstream uff.cpp.
#include "uff-diagnostics.h"

nlohmann::json DiagnosticUff::topology() const
{
  using nlohmann::json;
  json types = json::array();
  json tuples = { { "bond", json::array() }, { "angle", json::array() },
                  { "oop", json::array() }, { "torsion", json::array() },
                  { "vdw", json::array() } };
  json exclusions = json::array();
  json angleCoordinations = json::array();
  if (d) {
    for (const auto row : d->m_atomTypes) {
      if (row < 0) {
        types.push_back({ { "row", row } });
      } else {
        const auto& type = uffparams[row];
        types.push_back({ { "row", row }, { "atomicNumber", type.element },
                          { "label", type.label } });
      }
    }
    for (const auto& t : d->m_bonds)
      tuples["bond"].push_back({ t._atom1, t._atom2 });
    for (const auto& t : d->m_angles) {
      tuples["angle"].push_back({ t._atom1, t._atom2, t._atom3 });
      angleCoordinations.push_back(t.coordination);
    }
    for (const auto& t : d->m_oops)
      tuples["oop"].push_back({ t._atom1, t._atom2, t._atom3, t._atom4 });
    for (const auto& t : d->m_torsions)
      tuples["torsion"].push_back({ t._atom1, t._atom2, t._atom3, t._atom4 });
    for (const auto& t : d->m_vdws)
      tuples["vdw"].push_back({ t._atom1, t._atom2 });
    // The set is unordered. Write its membership in atom-index order.
    for (Avogadro::Index i = 0; i < m_molecule->atomCount(); ++i) {
      for (Avogadro::Index j = i + 1; j < m_molecule->atomCount(); ++j) {
        if (d->m_excludedPairs.count(d->pairKey(i, j)))
          exclusions.push_back({ i, j });
      }
    }
  }
  return { { "atomTypes", types }, { "tuples", tuples }, { "excludedPairs", exclusions },
           { "angleCoordinations", angleCoordinations } };
}
