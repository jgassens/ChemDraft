# ABC-FIRE and Hybrid on the Spin 3D UFF reference set

Measured on Apple M1 Pro (darwin arm64, kernel 25.6.0) using AppleClang 21.0.0.21000401, CMake Release, and Eigen 3.4.0. Ran on 2026-11-18T21:05:00.775Z with pinned Avogadrolibs `416651ddaef33a4e20392392e7c0b505d446491b`. Build flags and individual timings are in the [JSON](fire-vs-hybrid.json).

The comparison covers 21 molecules, 23 explicit-hydrogen graphs including both committed Kekulé forms, and 69 paired starts per regime. Each graph starts from its committed seed or linear snapshot and two jitters of that same snapshot. The fixed xorshift32 seeds are 416651 and 416654 with per-axis ranges ±0.16 Å and ±0.3 Å, respectively. The runs omitted `antimony-trihydride` (element parameter work), `charged-pair` (no explicit-hydrogen variant), `element-scan-probe` (element parameter work), `iodomethane` (element parameter work), `iron-hexafluoride` (no explicit-hydrogen variant), `sulfur-hexafluoride` (no explicit-hydrogen variant).

Both methods use the same all-mobile mask, coordinates, UFF input graph, and 0.01 kJ/(mol·Å) threshold on the RMS of mobile Cartesian gradient components. The benchmark applies the sidecar's radius and bond-length checks at chunk boundaries, using the committed baseline geometry for rest lengths. It measures the optimizer and those chunk checks from a frozen input. Drag targets, post-release clamping and drift removal are outside this measurement.

Release uses the sidecar's 8 requests of 12 iterations, stopping early on optimizer failure or a nonfinite endpoint. The release table classifies the final chunk. Tail stops on the first qualifying chunk boundary or when no further request fits within the cap of 10,000 actual iterations. The pinned L-BFGS solver performs one more iteration than requested at its iteration limit. The tables count actual iterations and the JSON also records requested iterations and the last completed ABC-FIRE iteration before Hybrid hands off to L-BFGS.

Wall times are single-threaded medians of 5 repeats per run after 1 warm-up. The timer includes the chunk loop and benchmark accounting. UFF setup, initial probe, alignment and output are outside the timer. A fused UFF evaluation counts once as an energy evaluation and once as a force evaluation. Energy-increase counts include rejected line-search trials as well as any accepted chunk above the run's starting energy.

Energy differences are ABC-FIRE minus Hybrid in kJ/mol. Absolute differences of 0.02 kJ/mol or less count as ties. F/E gives force and energy evaluations. Stereo checks compare oriented geometry witnesses for the 2-butanol and 2-butene inputs at the start, at each accepted chunk, and after each optimizer step in the warm-up replay. The graph audit checks ordered atoms, elements, charges and bond endpoints and orders. Coordinates do not infer new bonds.

## Default release

| Molecule / Kekulé / start | ΔE (kJ/mol) | FIRE iterations | FIRE F/E | FIRE ms | FIRE status | Hybrid iterations | Hybrid F/E | Hybrid ms | Hybrid status |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| 2-butanol-r / seed | 0.401019 | 96 | 97/97 | 0.3709 | capped | 100 | 110/110 | 0.4617 | capped |
| 2-butanol-r / jitter-a | 0.122229 | 96 | 97/97 | 0.4008 | capped | 99 | 104/104 | 0.4603 | capped |
| 2-butanol-r / jitter-b | 0.290456 | 96 | 97/97 | 0.3755 | capped | 97 | 102/102 | 0.4044 | capped |
| 2-butanol-s / seed | 0.434001 | 96 | 97/97 | 0.3713 | capped | 97 | 103/103 | 0.4050 | capped |
| 2-butanol-s / jitter-a | 0.000000 | 96 | 97/97 | 0.3749 | capped | 96 | 97/97 | 0.3751 | capped |
| 2-butanol-s / jitter-b | 0.000000 | 96 | 97/97 | 0.3932 | capped | 96 | 97/97 | 0.3919 | capped |
| 2-butanol-unspecified / seed | 0.168441 | 96 | 97/97 | 0.3850 | capped | 99 | 107/107 | 0.4584 | capped |
| 2-butanol-unspecified / jitter-a | 0.032358 | 96 | 97/97 | 0.3772 | capped | 98 | 103/103 | 0.4215 | capped |
| 2-butanol-unspecified / jitter-b | 0.002602 | 96 | 97/97 | 0.3934 | capped | 98 | 105/105 | 0.4355 | capped |
| 2-butene-e / seed | 0.128423 | 96 | 97/97 | 0.2216 | capped | 99 | 106/106 | 0.2687 | capped |
| 2-butene-e / jitter-a | 0.045028 | 96 | 97/97 | 0.2247 | capped | 99 | 104/104 | 0.2673 | capped |
| 2-butene-e / jitter-b | 0.145399 | 96 | 97/97 | 0.2238 | capped | 97 | 101/101 | 0.2447 | capped |
| 2-butene-unspecified / seed | 2.939473 | 96 | 97/97 | 0.2291 | capped | 99 | 106/106 | 0.2843 | capped |
| 2-butene-unspecified / jitter-a | 5.526005 | 96 | 97/97 | 0.2328 | capped | 100 | 105/105 | 0.2900 | capped |
| 2-butene-unspecified / jitter-b | 2.958665 | 96 | 97/97 | 0.2250 | capped | 97 | 101/101 | 0.2431 | capped |
| 2-butene-z / seed | 2.925681 | 96 | 97/97 | 0.2225 | capped | 99 | 106/106 | 0.2696 | capped |
| 2-butene-z / jitter-a | 1.631334 | 96 | 97/97 | 0.2255 | capped | 98 | 103/103 | 0.2580 | capped |
| 2-butene-z / jitter-b | 4.816442 | 96 | 97/97 | 0.2265 | capped | 98 | 106/106 | 0.2663 | capped |
| acetamide / seed | 0.006209 | 96 | 97/97 | 0.1683 | capped | 97 | 101/101 | 0.1827 | capped |
| acetamide / jitter-a | 0.030467 | 96 | 97/97 | 0.1695 | capped | 97 | 102/102 | 0.1843 | capped |
| acetamide / jitter-b | 0.000000 | 96 | 97/97 | 0.1685 | capped | 96 | 97/97 | 0.1695 | capped |
| acetate / seed | 0.006457 | 96 | 97/97 | 0.1100 | capped | 99 | 105/105 | 0.1409 | capped |
| acetate / jitter-a | 0.009783 | 96 | 97/97 | 0.1095 | capped | 98 | 105/105 | 0.1314 | capped |
| acetate / jitter-b | 0.001846 | 96 | 97/97 | 0.1103 | capped | 97 | 100/100 | 0.1201 | capped |
| acetylene / linear | 0.000000 | 96 | 97/97 | 0.0130 | converged | 66 | 334/334 | 0.0477 | converged |
| acetylene / jitter-a | 0.000000 | 96 | 97/97 | 0.0205 | converged | 78 | 162/162 | 0.0374 | converged |
| acetylene / jitter-b | 0.000017 | 96 | 97/97 | 0.0209 | capped | 84 | 88/88 | 0.0248 | converged |
| benzene / A / seed | 0.000000 | 96 | 97/97 | 0.2481 | converged | 61 | 68/68 | 0.1899 | converged |
| benzene / A / jitter-a | 0.000027 | 96 | 97/97 | 0.2477 | capped | 81 | 89/89 | 0.2407 | converged |
| benzene / A / jitter-b | 0.000140 | 96 | 97/97 | 0.2505 | capped | 81 | 87/87 | 0.2381 | capped |
| benzene / B / seed | 0.000000 | 96 | 97/97 | 0.2457 | converged | 61 | 68/68 | 0.1982 | converged |
| benzene / B / jitter-a | 0.000015 | 96 | 97/97 | 0.2546 | capped | 75 | 82/82 | 0.2379 | capped |
| benzene / B / jitter-b | 0.004939 | 96 | 97/97 | 0.2520 | capped | 81 | 87/87 | 0.2381 | capped |
| cyclohexane-chair / seed | 0.000869 | 96 | 97/97 | 0.6056 | capped | 93 | 97/97 | 0.6218 | capped |
| cyclohexane-chair / jitter-a | 0.000141 | 96 | 97/97 | 0.6029 | capped | 88 | 94/94 | 0.6094 | capped |
| cyclohexane-chair / jitter-b | 0.002508 | 96 | 97/97 | 0.6132 | capped | 98 | 106/106 | 0.6898 | capped |
| cyclopropane / seed | 0.018999 | 96 | 97/97 | 0.2927 | capped | 80 | 84/84 | 0.2685 | capped |
| cyclopropane / jitter-a | 0.000000 | 96 | 97/97 | 0.3090 | capped | 96 | 97/97 | 0.3002 | capped |
| cyclopropane / jitter-b | 0.000067 | 96 | 97/97 | 0.2895 | capped | 80 | 84/84 | 0.2644 | capped |
| ethanol / seed | 0.000000 | 96 | 97/97 | 0.1666 | capped | 96 | 97/97 | 0.1665 | capped |
| ethanol / jitter-a | 0.175099 | 96 | 97/97 | 0.1656 | capped | 97 | 103/103 | 0.1844 | capped |
| ethanol / jitter-b | 0.000000 | 96 | 97/97 | 0.1678 | capped | 96 | 97/97 | 0.1689 | capped |
| formaldehyde / seed | 0.000000 | 96 | 97/97 | 0.0338 | converged | 62 | 257/257 | 0.0976 | converged |
| formaldehyde / jitter-a | 0.000000 | 96 | 97/97 | 0.0349 | converged | 61 | 127/127 | 0.0552 | converged |
| formaldehyde / jitter-b | 0.000000 | 96 | 97/97 | 0.0368 | converged | 68 | 74/74 | 0.0360 | converged |
| furan / seed | 0.000002 | 96 | 97/97 | 0.1693 | capped | 74 | 78/78 | 0.1450 | capped |
| furan / jitter-a | 0.000032 | 96 | 97/97 | 0.1675 | capped | 73 | 81/81 | 0.1556 | capped |
| furan / jitter-b | 0.005016 | 96 | 97/97 | 0.1695 | capped | 97 | 101/101 | 0.1843 | capped |
| hydrogen-peroxide / seed | 0.022328 | 96 | 97/97 | 0.0281 | capped | 96 | 101/101 | 0.0355 | converged |
| hydrogen-peroxide / jitter-a | 0.002431 | 96 | 97/97 | 0.0281 | capped | 65 | 72/72 | 0.0348 | converged |
| hydrogen-peroxide / jitter-b | 0.000156 | 96 | 97/97 | 0.0282 | capped | 65 | 222/222 | 0.0748 | converged |
| methane / seed | 0.000000 | 96 | 97/97 | 0.0418 | converged | 61 | 106/106 | 0.0587 | converged |
| methane / jitter-a | 0.000000 | 96 | 97/97 | 0.0415 | converged | 68 | 132/132 | 0.0657 | converged |
| methane / jitter-b | 0.000000 | 96 | 97/97 | 0.0415 | converged | 70 | 244/244 | 0.1101 | converged |
| methylammonium / seed | 0.009962 | 96 | 97/97 | 0.1382 | capped | 89 | 95/95 | 0.1495 | converged |
| methylammonium / jitter-a | 0.019767 | 96 | 97/97 | 0.1376 | capped | 97 | 101/101 | 0.1509 | capped |
| methylammonium / jitter-b | 0.000000 | 96 | 97/97 | 0.1370 | capped | 96 | 97/97 | 0.1382 | capped |
| n-butane / seed | 0.000000 | 96 | 97/97 | 0.3443 | capped | 96 | 97/97 | 0.3442 | capped |
| n-butane / jitter-a | 0.000000 | 96 | 97/97 | 0.3553 | capped | 96 | 97/97 | 0.3490 | capped |
| n-butane / jitter-b | 0.020840 | 96 | 97/97 | 0.3500 | capped | 97 | 102/102 | 0.4108 | capped |
| naphthalene / A / seed | 0.000002 | 96 | 97/97 | 0.4505 | capped | 73 | 82/82 | 0.4008 | capped |
| naphthalene / A / jitter-a | 0.040002 | 96 | 97/97 | 0.4570 | capped | 91 | 100/100 | 0.4932 | capped |
| naphthalene / A / jitter-b | 0.005650 | 96 | 97/97 | 0.4586 | capped | 97 | 104/104 | 0.5134 | capped |
| naphthalene / B / seed | 0.000002 | 96 | 97/97 | 0.4507 | capped | 73 | 82/82 | 0.4019 | capped |
| naphthalene / B / jitter-a | 0.005839 | 96 | 97/97 | 0.4730 | capped | 90 | 97/97 | 0.4916 | capped |
| naphthalene / B / jitter-b | 0.003057 | 96 | 97/97 | 0.4653 | capped | 98 | 104/104 | 0.5385 | capped |
| water / seed | 0.000000 | 96 | 97/97 | 0.0150 | converged | 60 | 368/368 | 0.0627 | converged |
| water / jitter-a | 0.000000 | 96 | 97/97 | 0.0150 | converged | 60 | 405/405 | 0.0684 | converged |
| water / jitter-b | 0.000000 | 96 | 97/97 | 0.0157 | converged | 59 | 366/366 | 0.0624 | converged |

ABC-FIRE reached the lower final energy in 0 pairs, Hybrid in 20, with 49 ties and 0 pairs without comparable energies.

| Method | Converged at exit | Capped | Failed | NaN | Reached RMS threshold at any boundary | Median / worst iterations | Median / worst ms | Evaluated / optimizer step / accepted chunk / final above run start | Handoffs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ABC-FIRE | 13 | 56 | 0 | 0 | 13 | 96 / 96 | 0.2250 / 0.6132 | 35 / 35 / 2 / 0 | 0 |
| Hybrid | 19 | 50 | 0 | 0 | 19 | 96 / 100 | 0.2381 / 0.6898 | 35 / 35 / 2 / 0 | 60 |

The status columns identify all cap exits and failures by start.
Hybrid handed off after 36–84 ABC-FIRE iterations.
Hybrid alone met the RMS threshold at exit on acetylene / jitter-b, benzene / A / jitter-a, hydrogen-peroxide / seed, hydrogen-peroxide / jitter-a, hydrogen-peroxide / jitter-b, methylammonium / seed.

- Failed or NaN exits. None.
- Runs with nonfinite energy evaluations. None.
- Tetrahedral witness changes at internal optimizer steps. None.
- Stereo changes or degeneracies at accepted chunk boundaries. None.
- Stereo changes or degeneracies at internal optimizer steps. None.
- Connectivity or graph changes. None.
- Geometry guard rejections. None.

## Extended tail

| Molecule / Kekulé / start | ΔE (kJ/mol) | FIRE iterations | FIRE F/E | FIRE ms | FIRE status | Hybrid iterations | Hybrid F/E | Hybrid ms | Hybrid status |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| 2-butanol-r / seed | 0.000006 | 408 | 409/409 | 1.6348 | converged | 273 | 317/317 | 1.4311 | converged |
| 2-butanol-r / jitter-a | 0.000016 | 360 | 361/361 | 1.3801 | converged | 254 | 291/291 | 1.2908 | converged |
| 2-butanol-r / jitter-b | 0.000003 | 372 | 373/373 | 1.4490 | converged | 244 | 276/276 | 1.1820 | converged |
| 2-butanol-s / seed | 0.000043 | 492 | 493/493 | 1.9597 | converged | 304 | 348/348 | 1.5676 | converged |
| 2-butanol-s / jitter-a | 0.000030 | 408 | 409/409 | 1.5638 | converged | 307 | 347/347 | 1.5070 | converged |
| 2-butanol-s / jitter-b | 0.000019 | 396 | 397/397 | 1.5444 | converged | 307 | 355/355 | 1.5299 | converged |
| 2-butanol-unspecified / seed | 0.000025 | 372 | 373/373 | 1.4452 | converged | 284 | 330/330 | 1.4357 | converged |
| 2-butanol-unspecified / jitter-a | 0.000022 | 300 | 301/301 | 1.1670 | converged | 240 | 277/277 | 1.2477 | converged |
| 2-butanol-unspecified / jitter-b | 0.000025 | 180 | 181/181 | 0.7067 | converged | 179 | 205/205 | 0.8880 | converged |
| 2-butene-e / seed | 0.001054 | 8328 | 8329/8329 | 19.0962 | converged | 2704 | 3085/3085 | 8.8774 | converged |
| 2-butene-e / jitter-a | 0.001078 | 7176 | 7177/7177 | 16.7187 | converged | 1906 | 2133/2133 | 6.2591 | converged |
| 2-butene-e / jitter-b | 0.001466 | 6708 | 6709/6709 | 15.3820 | converged | 1921 | 2138/2138 | 6.0862 | converged |
| 2-butene-unspecified / seed | 0.001267 | 5928 | 5929/5929 | 13.6604 | converged | 1516 | 1685/1685 | 4.9181 | converged |
| 2-butene-unspecified / jitter-a | 0.001541 | 5592 | 5593/5593 | 12.9053 | converged | 1426 | 1573/1573 | 4.5671 | converged |
| 2-butene-unspecified / jitter-b | 0.000442 | 6216 | 6217/6217 | 14.2851 | converged | 1228 | 1366/1366 | 3.8984 | converged |
| 2-butene-z / seed | 0.001123 | 5724 | 5725/5725 | 13.0959 | converged | 1411 | 1572/1572 | 4.5208 | converged |
| 2-butene-z / jitter-a | 0.001361 | 6732 | 6733/6733 | 15.4219 | converged | 1616 | 1803/1803 | 5.1900 | converged |
| 2-butene-z / jitter-b | 0.001248 | 5496 | 5497/5497 | 12.5825 | converged | 1253 | 1399/1399 | 3.9680 | converged |
| acetamide / seed | 0.000762 | 6000 | 6001/6001 | 10.1705 | converged | 2221 | 2657/2657 | 5.4800 | converged |
| acetamide / jitter-a | 0.000566 | 5784 | 5785/5785 | 9.6972 | converged | 2645 | 3217/3217 | 6.7094 | converged |
| acetamide / jitter-b | 0.000728 | 6528 | 6529/6529 | 11.0200 | converged | 979 | 1100/1100 | 2.3204 | converged |
| acetate / seed | 0.001545 | 10000 | 10001/10001 | 11.3719 | capped | 1654 | 1890/1890 | 2.8488 | converged |
| acetate / jitter-a | 0.001095 | 9084 | 9085/9085 | 10.2657 | converged | 3212 | 3902/3902 | 5.8105 | converged |
| acetate / jitter-b | 0.001361 | 8940 | 8941/8941 | 10.1257 | converged | 4450 | 5404/5404 | 7.8747 | converged |
| acetylene / linear | 0.000000 | 72 | 73/73 | 0.0096 | converged | 54 | 94/94 | 0.0147 | converged |
| acetylene / jitter-a | 0.000000 | 96 | 97/97 | 0.0204 | converged | 70 | 73/73 | 0.0204 | converged |
| acetylene / jitter-b | 0.000000 | 120 | 121/121 | 0.0259 | converged | 80 | 82/82 | 0.0217 | converged |
| benzene / A / seed | 0.000001 | 72 | 73/73 | 0.1863 | converged | 49 | 53/53 | 0.1440 | converged |
| benzene / A / jitter-a | 0.000001 | 120 | 121/121 | 0.3085 | converged | 77 | 84/84 | 0.2261 | converged |
| benzene / A / jitter-b | -0.000000 | 120 | 121/121 | 0.3105 | converged | 93 | 102/102 | 0.2836 | converged |
| benzene / B / seed | 0.000001 | 72 | 73/73 | 0.1928 | converged | 49 | 53/53 | 0.1501 | converged |
| benzene / B / jitter-a | 0.000000 | 108 | 109/109 | 0.2778 | converged | 79 | 88/88 | 0.2470 | converged |
| benzene / B / jitter-b | 0.000003 | 132 | 133/133 | 0.3402 | converged | 89 | 97/97 | 0.2684 | converged |
| cyclohexane-chair / seed | 0.000002 | 144 | 145/145 | 0.8951 | converged | 101 | 107/107 | 0.6898 | converged |
| cyclohexane-chair / jitter-a | -0.000002 | 144 | 145/145 | 0.8965 | converged | 92 | 99/99 | 0.6425 | converged |
| cyclohexane-chair / jitter-b | 0.000004 | 144 | 145/145 | 0.9040 | converged | 106 | 117/117 | 0.7622 | converged |
| cyclopropane / seed | 0.000001 | 156 | 157/157 | 0.4758 | converged | 100 | 111/111 | 0.3637 | converged |
| cyclopropane / jitter-a | -0.000000 | 180 | 181/181 | 0.5577 | converged | 119 | 128/128 | 0.4297 | converged |
| cyclopropane / jitter-b | -0.000001 | 132 | 133/133 | 0.4025 | converged | 124 | 139/139 | 0.4667 | converged |
| ethanol / seed | 0.000002 | 276 | 277/277 | 0.4705 | converged | 219 | 246/246 | 0.4954 | converged |
| ethanol / jitter-a | 0.000012 | 276 | 277/277 | 0.4678 | converged | 179 | 202/202 | 0.4002 | converged |
| ethanol / jitter-b | 0.000011 | 276 | 277/277 | 0.4729 | converged | 222 | 254/254 | 0.4960 | converged |
| formaldehyde / seed | 0.000000 | 84 | 85/85 | 0.0297 | converged | 46 | 49/49 | 0.0227 | converged |
| formaldehyde / jitter-a | 0.000000 | 96 | 97/97 | 0.0348 | converged | 45 | 47/47 | 0.0217 | converged |
| formaldehyde / jitter-b | 0.000000 | 84 | 85/85 | 0.0305 | converged | 56 | 59/59 | 0.0253 | converged |
| furan / seed | 0.000000 | 108 | 109/109 | 0.1895 | converged | 82 | 88/88 | 0.1669 | converged |
| furan / jitter-a | -0.000000 | 132 | 133/133 | 0.2311 | converged | 89 | 103/103 | 0.2017 | converged |
| furan / jitter-b | 0.000000 | 144 | 145/145 | 0.2520 | converged | 105 | 111/111 | 0.2062 | converged |
| hydrogen-peroxide / seed | 0.000004 | 216 | 217/217 | 0.0620 | converged | 96 | 101/101 | 0.0352 | converged |
| hydrogen-peroxide / jitter-a | 0.000004 | 180 | 181/181 | 0.0518 | converged | 53 | 57/57 | 0.0253 | converged |
| hydrogen-peroxide / jitter-b | 0.000002 | 168 | 169/169 | 0.0484 | converged | 49 | 52/52 | 0.0219 | converged |
| methane / seed | -0.000000 | 84 | 85/85 | 0.0363 | converged | 45 | 48/48 | 0.0256 | converged |
| methane / jitter-a | 0.000000 | 84 | 85/85 | 0.0363 | converged | 56 | 60/60 | 0.0302 | converged |
| methane / jitter-b | 0.000000 | 96 | 97/97 | 0.0415 | converged | 58 | 60/60 | 0.0313 | converged |
| methylammonium / seed | 0.000007 | 168 | 169/169 | 0.2381 | converged | 89 | 95/95 | 0.1439 | converged |
| methylammonium / jitter-a | 0.000001 | 216 | 217/217 | 0.3145 | converged | 105 | 112/112 | 0.1735 | converged |
| methylammonium / jitter-b | 0.000006 | 192 | 193/193 | 0.2712 | converged | 109 | 115/115 | 0.1765 | converged |
| n-butane / seed | 0.000018 | 240 | 241/241 | 0.8530 | converged | 188 | 205/205 | 0.7859 | converged |
| n-butane / jitter-a | 0.000027 | 264 | 265/265 | 0.9624 | converged | 179 | 201/201 | 0.8147 | converged |
| n-butane / jitter-b | 0.000027 | 240 | 241/241 | 0.8722 | converged | 148 | 163/163 | 0.6282 | converged |
| naphthalene / A / seed | 0.000001 | 108 | 109/109 | 0.5064 | converged | 77 | 87/87 | 0.4268 | converged |
| naphthalene / A / jitter-a | 0.000009 | 216 | 217/217 | 1.0114 | converged | 159 | 187/187 | 0.9621 | converged |
| naphthalene / A / jitter-b | 0.000002 | 180 | 181/181 | 0.8422 | converged | 133 | 149/149 | 0.7425 | converged |
| naphthalene / B / seed | 0.000001 | 108 | 109/109 | 0.5063 | converged | 77 | 87/87 | 0.4359 | converged |
| naphthalene / B / jitter-a | 0.000007 | 168 | 169/169 | 0.7920 | converged | 162 | 187/187 | 0.9570 | converged |
| naphthalene / B / jitter-b | 0.000001 | 156 | 157/157 | 0.7588 | converged | 166 | 189/189 | 0.9921 | converged |
| water / seed | 0.000000 | 72 | 73/73 | 0.0113 | converged | 44 | 66/66 | 0.0142 | converged |
| water / jitter-a | 0.000000 | 72 | 73/73 | 0.0114 | converged | 44 | 85/85 | 0.0167 | converged |
| water / jitter-b | 0.000000 | 60 | 61/61 | 0.0100 | converged | 43 | 46/46 | 0.0112 | converged |

ABC-FIRE reached the lower final energy in 0 pairs, Hybrid in 0, with 69 ties and 0 pairs without comparable energies.

| Method | Converged at exit | Capped | Failed | NaN | Reached RMS threshold at any boundary | Median / worst iterations | Median / worst ms | Evaluated / optimizer step / accepted chunk / final above run start | Handoffs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ABC-FIRE | 68 | 1 | 0 | 0 | 68 | 180 / 10000 | 0.5577 / 19.0962 | 35 / 35 / 2 / 0 | 0 |
| Hybrid | 69 | 0 | 0 | 0 | 69 | 124 / 4450 | 0.4960 / 8.8774 | 35 / 35 / 2 / 0 | 69 |

The status columns identify all cap exits and failures by start.
Hybrid handed off after 36–108 ABC-FIRE iterations.
Hybrid alone met the RMS threshold at exit on acetate / seed.
ABC-FIRE capped on acetate / seed at 10,000 iterations and 0.01201 kJ/(mol·Å) RMS.

Both methods crossed the perpendicular alkene witness and stayed on its opposite side at exit on 2-butene-unspecified / seed, 2-butene-unspecified / jitter-a, 2-butene-unspecified / jitter-b, 2-butene-z / seed, 2-butene-z / jitter-a, 2-butene-z / jitter-b. Endpoint projected cosines ranged from -0.114 to -0.103.

- Failed or NaN exits. None.
- Runs with nonfinite energy evaluations. None.
- Tetrahedral witness changes at internal optimizer steps. None.
- Stereo changes or degeneracies at accepted chunk boundaries. ABC-FIRE on 2-butene-unspecified / seed, ABC-FIRE on 2-butene-unspecified / jitter-a, ABC-FIRE on 2-butene-unspecified / jitter-b, ABC-FIRE on 2-butene-z / seed, ABC-FIRE on 2-butene-z / jitter-a, ABC-FIRE on 2-butene-z / jitter-b, Hybrid on 2-butene-unspecified / seed, Hybrid on 2-butene-unspecified / jitter-a, Hybrid on 2-butene-unspecified / jitter-b, Hybrid on 2-butene-z / seed, Hybrid on 2-butene-z / jitter-a, Hybrid on 2-butene-z / jitter-b.
- Stereo changes or degeneracies at internal optimizer steps. ABC-FIRE on 2-butene-unspecified / seed, ABC-FIRE on 2-butene-unspecified / jitter-a, ABC-FIRE on 2-butene-unspecified / jitter-b, ABC-FIRE on 2-butene-z / seed, ABC-FIRE on 2-butene-z / jitter-a, ABC-FIRE on 2-butene-z / jitter-b, Hybrid on 2-butene-unspecified / seed, Hybrid on 2-butene-unspecified / jitter-a, Hybrid on 2-butene-unspecified / jitter-b, Hybrid on 2-butene-z / seed, Hybrid on 2-butene-z / jitter-a, Hybrid on 2-butene-z / jitter-b.
- Connectivity or graph changes. None.
- Geometry guard rejections. None.
