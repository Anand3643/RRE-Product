/**
 * Tailwind is compiled AHEAD of time (npm run build:css -> public/vendor/tailwind.css) instead of in the browser on every page load.
 * Same version (3.4.17) and the same settings as the in-browser configuration that index.html used to carry.
 */
module.exports = {
  content: ['./public/**/*.html', './public/**/*.js', '!./public/vendor/**'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['Consolas', 'Cascadia Code', 'JetBrains Mono', 'Monaco', 'Courier New', 'monospace']
      }
    }
  }
};
