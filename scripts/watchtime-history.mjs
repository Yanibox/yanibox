import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dateInMoscow } from '../watchtime-period.mjs';

export async function publishWatchtimeHistory(directory, global) {
  const destination = 'dist/data/watchtime-history';
  await mkdir(destination, { recursive: true });
  const days = [];

  if (directory) {
    // Keep the earliest successful reading each Moscow day as its starting boundary.
    if (global && !global.stale) {
      const day = dateInMoscow(new Date(global.updatedAt));
      try {
        await writeFile(join(directory, day + '.json'), JSON.stringify(global) + '\n', { flag: 'wx' });
        console.log('Saved WizeBot boundary for ' + day);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    for (const name of (await readdir(directory)).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      days.push(name.slice(0, -5));
      await copyFile(join(directory, name), join(destination, name));
    }
  }
  return days;
}
