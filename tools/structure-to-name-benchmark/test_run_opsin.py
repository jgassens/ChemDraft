import unittest
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

# run_opsin does not use RDKit; keep this function-level test runnable without its optional dependency.
rdkit = ModuleType("rdkit")
rdkit.Chem = ModuleType("rdkit.Chem")
rdkit.RDLogger = SimpleNamespace(DisableLog=lambda _pattern: None)
sys.modules.setdefault("rdkit", rdkit)

from bench_roundtrip import run_opsin


class RunOpsinTests(unittest.TestCase):
    @patch("bench_roundtrip.subprocess.run")
    def test_mismatched_output_line_count_fails(self, run):
        run.return_value = SimpleNamespace(stdout="C\n", stderr="", returncode=0)

        with self.assertRaisesRegex(RuntimeError, r"2 names in, 1 lines out"):
            run_opsin(["first", "second"], "java", "opsin.jar")


if __name__ == "__main__":
    unittest.main()
