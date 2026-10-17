const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.join(REPO_ROOT, 'src/slide_notes');
module.exports = {
  REPO_ROOT,
  APP_ROOT,
  STATIC_ROOT: path.join(APP_ROOT, 'static'),
  FRONTEND_ROOT: path.join(REPO_ROOT, 'frontend'),
  FIXTURES_ROOT: path.join(REPO_ROOT, 'tests/fixtures'),
  PYTHON: process.env.SLIDE_NOTES_TEST_PYTHON || path.join(REPO_ROOT, '.venv/bin/python'),
};
