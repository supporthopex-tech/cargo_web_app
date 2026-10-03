# Kuweka Hopex Express Cargo kwenye GitHub

1. Extract HOPEX-Express-Cargo-GitHub.zip.
2. Fungua folder hopex-express-cargo iliyotoka kwenye ZIP.
3. Fungua repository ya Hopex kwenye GitHub, kisha Add file → Upload files.
4. Upload contents za folder hiyo kwenye ROOT ya repository. package.json na
   index.html ziwe root, pamoja na folders src/, public/ na supabase/.

Kwa browser, upload kwa makundi haya ili kila kundi liwe chini ya files 100:

- Kwanza: files za root pamoja na public/, scripts/ na .figma/.
- Pili: folder src/.
- Tatu: folder supabase/.

Hifadhi folder structure na files zinazofichwa, kama .gitignore, .env.example na
.figma/make/site.json. site.json hutumiwa na vite.config.ts wakati wa build.
Kila kundi likimaliza upload, Commit changes; kisha endelea na kundi linalofuata.

Mwongozo rasmi:
https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository

Package ina source, Hopex branding na maandalizi ya Supabase. node_modules/,
dist/, screenshots za QA, temporary tools, archives nyingine na .env halisi
hazijapakiwa. Database bado haijaunganishwa.

Baada ya upload, thibitisha root ina package.json, pnpm-lock.yaml, vite.config.ts,
index.html, src/, public/, supabase/ na .figma/make/site.json.
