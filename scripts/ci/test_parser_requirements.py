"""Parse the shared lock and evaluate real PEP 508 selection, without installing."""
import itertools
from pathlib import Path
import unittest

try:
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
except ImportError:
    # Reuse the interpreter's pip packaging parser when standalone packaging is absent.
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement

LOCK = Path(__file__).resolve().parents[2] / "services/parser/requirements-lock.txt"


class ParserRequirementsTests(unittest.TestCase):
    def test_shared_lock_selects_exactly_one_compatible_torch_requirement(self):
        requirements = [
            Requirement(line) for line in LOCK.read_text().splitlines()
            if line.strip() and not line.startswith("#")
        ]
        versions = {"torch": "2.14.0", "torchvision": "0.29.0"}
        environments = itertools.product(
            ("linux", "win32", "darwin"),
            ("x86_64", "AMD64", "aarch64", "arm64"),
            ("3.12", "3.13", "3.14"),
            ("cpython", "pypy"),
        )
        for platform, machine, python, implementation in environments:
            env = default_environment()
            env.update(
                sys_platform=platform,
                platform_machine=machine,
                python_version=python,
                python_full_version=python + ".1",
                implementation_name=implementation,
                platform_python_implementation="CPython" if implementation == "cpython" else "PyPy",
            )
            cpu = (platform, machine, python, implementation) == ("linux", "x86_64", "3.13", "cpython")
            for name, version in versions.items():
                with self.subTest(platform=platform, machine=machine, python=python,
                                  implementation=implementation, package=name):
                    selected = [r for r in requirements if r.name == name
                                and (r.marker is None or r.marker.evaluate(env))]
                    self.assertEqual(len(selected), 1, selected)
                    requirement = selected[0]
                    if cpu:
                        self.assertEqual(
                            requirement.url,
                            f"https://download-r2.pytorch.org/whl/cpu/{name}-{version}%2Bcpu-"
                            "cp313-cp313-manylinux_2_28_x86_64.whl#sha256="
                            + {"torch": "160e1bc46aeded3111d2801f8ae10dc9a1b946843a7e126b4dbf5e19c5706e95",
                               "torchvision": "6ff3b816ec955f3ef9f32d1e698e1856549e2e03637c358ee067c6f5f17f74fa"}[name],
                        )
                    else:
                        self.assertIsNone(requirement.url)
                        self.assertEqual(str(requirement.specifier), f"=={version}")


if __name__ == "__main__":
    unittest.main()
