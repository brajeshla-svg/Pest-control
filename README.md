# AgriVision AI - free deployment guide

Everything here is free. You need: a Google account, a GitHub account, a Netlify account. No credit card.

## 1. Get a free Gemini API key
1. Go to https://aistudio.google.com/apikey and sign in.
2. Click "Create API key". Copy it. Keep it secret (never paste it into index.html).

## 2. Put the project on GitHub
1. Create a new repository on github.com (name: agrivision-ai).
2. Upload ALL files keeping this structure:
   - index.html
   - netlify.toml
   - netlify/functions/analyze.js
   (On GitHub: Add file > Upload files. The netlify folder must contain functions, which contains analyze.js.)

## 3. Deploy on Netlify (free)
1. Go to https://app.netlify.com > Add new site > Import an existing project > GitHub > pick your repository.
2. Leave build settings as they are. Click Deploy.
3. Open Site configuration > Environment variables > Add a variable:
   - Key: GEMINI_API_KEY
   - Value: (your key from step 1)
4. Go to Deploys > Trigger deploy > Deploy site (so the key is picked up).
5. Your site is live at https://something.netlify.app. You can rename it in Site configuration > Change site name.

## Free-tier limits (be aware)
- The free Gemini quota is shared by ALL visitors. Google changes the numbers often, so check AI Studio's rate-limit page.
- When the quota is used up, users see "AI quota is busy, try again later". It resets daily.
- Free-tier prompts may be used by Google to improve its products, so the footer tells users photos go to Gemini.
- If you get popular, you can add more free keys/projects or move to a paid key later. No code change is needed except the environment variable.

## Optional
- GEMINI_MODEL environment variable: force a specific model name (the function already falls back through several).
