# MakersBridge Marketplace

Netlify-ready static marketplace prototype.

## Live demo with GitHub Pages

This repository includes a GitHub Actions workflow that publishes the `dist` folder to GitHub Pages whenever `main` is updated.

After pushing the repository, open **Settings → Pages** and select **GitHub Actions** as the source if GitHub does not enable it automatically.

## Deploy with Git

Import this repository into Netlify. The included `netlify.toml` automatically uses `dist` as the publish directory, so no build command is required.

## Deploy manually

Open https://app.netlify.com/drop and drag the `dist` folder into the deploy area.

## Preview locally

```powershell
python -m http.server 4173 --directory dist
```

Then open http://127.0.0.1:4173/.

The site uses Thai baht demo prices, placeholder images, and separate routed views for Shop, Preorder, Shorts, Discover, and Partner.
