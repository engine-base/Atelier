/** Tailwind CSS + autoprefixer pipeline. tailwind.config.ts はリポジトリ root を参照。 */
export default {
  plugins: {
    tailwindcss: { config: '../../tailwind.config.ts' },
    autoprefixer: {},
  },
};
