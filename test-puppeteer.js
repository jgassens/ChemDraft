import puppeteer from 'puppeteer';
import { exec } from 'child_process';

const server = exec('pnpm dev:web');

setTimeout(async () => {
  try {
    console.log("Launching browser...");
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    console.log("Navigating to app...");
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.native-toolbar', { timeout: 10000 });
    
    // Create two molecules
    // Click the single bond tool
    await page.click('button[title="Single Bond"]');
    // Click on canvas
    await page.mouse.click(200, 200);
    // Click somewhere else
    await page.mouse.click(400, 400);

    // Switch to marquee tool
    await page.click('button[title="Marquee Selection"]');
    // Drag a marquee around both
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(500, 500);
    await page.mouse.up();

    await page.waitForSelector('.group-selection-frame', { timeout: 2000 });

    const beforeBbox = await page.evaluate(() => {
      const frame = document.querySelector('.group-selection-frame');
      const lines = Array.from(document.querySelectorAll('.molecule-glyph line.native-bond-hit-target'));
      return {
        frameWidth: frame.style.width,
        frameHeight: frame.style.height,
        lines: lines.map(l => ({ x1: l.getAttribute('x1'), y1: l.getAttribute('y1'), x2: l.getAttribute('x2'), y2: l.getAttribute('y2') }))
      };
    });

    console.log("BEFORE:", beforeBbox);

    // Grab the bottom-right resize handle
    const handle = await page.$('.native-molecule-resize-handle[data-corner="bottom-right"]');
    const box = await handle.boundingBox();
    
    await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width/2 + 100, box.y + box.height/2 + 100, { steps: 10 });
    
    // Wait a frame
    await new Promise(r => setTimeout(r, 100));

    const afterBbox = await page.evaluate(() => {
      const frame = document.querySelector('.group-selection-frame');
      const lines = Array.from(document.querySelectorAll('.molecule-glyph line.native-bond-hit-target'));
      return {
        frameWidth: frame.style.width,
        frameHeight: frame.style.height,
        lines: lines.map(l => ({ x1: l.getAttribute('x1'), y1: l.getAttribute('y1'), x2: l.getAttribute('x2'), y2: l.getAttribute('y2') }))
      };
    });

    console.log("AFTER (dragged):", afterBbox);

    await page.mouse.up();

    await browser.close();
  } catch (e) {
    console.error(e);
  } finally {
    server.kill();
    process.exit(0);
  }
}, 5000);

