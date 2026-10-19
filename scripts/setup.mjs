import { prepare } from './developer-tools.mjs';
try {
  await prepare();
  console.log('Streamglass is ready. Run npm run dev or npm run build:release.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
