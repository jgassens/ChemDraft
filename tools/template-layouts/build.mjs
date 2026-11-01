import { generator as crowns } from "./crown-ethers-cryptands.mjs";
import { generator as cyclodextrins } from "./cyclodextrins.mjs";
import { generator as cucurbiturils } from "./cucurbiturils.mjs";
import { generator as calixarenes } from "./calixarenes-pillararenes.mjs";
import { generator as cyclophanes } from "./cyclophanes.mjs";
import { generator as porphyrins } from "./porphyrins.mjs";
import { generator as fullerenes } from "./fullerenes.mjs";
import { writeFamily } from "./generate.mjs";

const check = process.argv.includes("--check");
let current = true;
for (const generator of [crowns, cyclodextrins, cucurbiturils, calixarenes, cyclophanes, porphyrins, fullerenes]) {
  if (!writeFamily(generator, check)) current = false;
}
if (!current) process.exitCode = 1;
