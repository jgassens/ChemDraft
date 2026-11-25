import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { sanitizeSvgPicture } from "../../packages/export-engine/src/svgSafety/svgSanitizer.ts";
import { readSvgInfo } from "../../packages/chem-core/src/imageInfo.ts";
import { packSchema, svgPathSchema } from "../../packages/art-library/src/index.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dest = path.join(root,"data","art","bioart");
const {window}=new JSDOM("");
const options={domParser:new window.DOMParser(),xmlSerializer:new window.XMLSerializer()};
const hash=s=>createHash("sha256").update(s).digest("hex");
const check=process.argv.includes("--check");
if (check) {
  const pack=packSchema.parse(JSON.parse(await readFile(path.join(dest,"pack.json"),"utf8")));
  for(const item of pack.items) for(const variant of Object.values(item.variants)) {
    const source=await readFile(path.join(dest,...variant.file.split("/")),"utf8");
    if(hash(source)!==variant.sha256) throw new Error(`Hash mismatch: ${variant.file}`);
    const result=sanitizeSvgPicture(source,options);
    if(!result.ok || result.svg!==source || result.removedActive || result.removedExternal) throw new Error(`Not sanitized: ${variant.file}`);
    const size=readSvgInfo(source)?.physicalSize;
    if(!size || size.width!==variant.width || size.height!==variant.height) throw new Error(`Size mismatch: ${variant.file}`);
  }
  console.log(`Verified ${pack.items.length} items`);
} else {
  const sourceDir=process.argv[2]; if(!sourceDir) throw new Error("Provide the BioArt source directory");
  const manifest=JSON.parse(await readFile(path.join(sourceDir,"manifest.json"),"utf8"));
  const pack={id:"bioart",name:"BioArt",version:"3.1",license:"CC-BY-4.0",attribution:"ChemDraft BioArt",items:[]};
  let changed=0, active=0, external=0;
  for(const subject of manifest.subjects) {
    const item={id:subject.id,name:subject.name,description:subject.description,category:subject.category,subcategory:subject.subcategory,keywords:[...new Set([subject.group,subject.subcategory,subject.source_display_name].filter(x=>typeof x==="string" && x.length))],variants:{}};
    for(const [variant,relative] of Object.entries(subject.variants)) {
      if(!svgPathSchema.safeParse(relative).success || !relative.startsWith("assets/")) throw new Error(`Unsafe source: ${relative}`);
      const input=await readFile(path.join(sourceDir,...relative.split("/")),"utf8");
      const result=sanitizeSvgPicture(input,options); if(!result.ok) throw new Error(`${relative}: ${result.error}`);
      if(input!==result.svg) changed++; if(result.removedActive) active++; if(result.removedExternal) external++;
      const size=readSvgInfo(result.svg)?.physicalSize; if(!size) throw new Error(`Missing size: ${relative}`);
      const file=`art/${relative.slice("assets/".length)}`;
      item.variants[variant]={file,sha256:hash(result.svg),width:size.width,height:size.height};
      const target=path.join(dest,...file.split("/")); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,result.svg);
    }
    pack.items.push(item);
  }
  packSchema.parse(pack); await writeFile(path.join(dest,"pack.json"),JSON.stringify(pack,null,2)+"\n");
  console.log(`Built ${pack.items.length} items; ${changed} serialized differently, ${active} active content removals, ${external} external or unsupported content removals`);
}
