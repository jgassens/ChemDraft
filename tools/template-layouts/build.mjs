import { generator as crowns } from "./crown-ethers-cryptands.mjs";
import { generator as cyclodextrins } from "./cyclodextrins.mjs";
import { generator as cucurbiturils } from "./cucurbiturils.mjs";
import { generator as calixarenes } from "./calixarenes-pillararenes.mjs";
import { generator as cyclophanes } from "./cyclophanes.mjs";
import { generator as porphyrins } from "./porphyrins.mjs";
import { generator as fullerenes } from "./fullerenes.mjs";
import { writeFamily } from "./generate.mjs";

const check = process.argv.includes("--check");
const variantIndex = process.argv.indexOf("--calix4-variant");
const variant = variantIndex < 0 ? "B" : process.argv[variantIndex + 1];
if (!["A", "B"].includes(variant)) throw new Error("--calix4-variant must be A or B");
let current = true;
for (const generator of [crowns, cyclodextrins, cucurbiturils, calixarenes, cyclophanes, porphyrins, fullerenes]) {
  const selected = generator === calixarenes
    ? { ...generator, generateTemplates: () => generator.generateTemplates(variant) } : generator;
  if (!writeFamily(selected, check)) current = false;
}
if (!current) process.exitCode = 1;
