# URL Filtering Chrome Extension

A Chrome extension that blocks downloads from specified URL categories and risk levels.

## Features

- Intercepts downloads before they start and checks URLs against a classification API
- Blocks downloads from 'Social Networking' sites or with risk level > 1
- Displays visual indication to users when downloads are blocked
- Handles downloads initiated through various methods
- Uses `pendingDownloads` to manage download information asynchronously

## Project Structure

The extension is organized following SOLID principles with a modular architecture:

```
src/
├── background.js                 # Main entry point with event listeners
├── foreground.js                 # Content script for page modifications
├── manifest.json                 # Extension manifest
├── icons/                        # Extension icons
│   ├── icon128.png
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
├── popup/                        # Extension popup UI
│   ├── popup.css
│   ├── popup.html
└── ...
```

## Development Notes

This extension uses a modular design pattern but implements it through global objects due to the constraints of Manifest V2. Each service is loaded in the correct order via the manifest.json file.

If you want to use native ES modules:

1. Convert the extension to Manifest V3
2. Set up a build process using Webpack or Rollup
3. Install packages: `npm install --save-dev webpack webpack-cli`
4. Create a webpack.config.js file to bundle the modules
5. Update the manifest.json to use the bundled file

## How It Works

1. The extension intercepts downloads using Chrome's download API
2. It sends the URL to a classification API for analysis
3. Based on the URL category and risk level, it allows or blocks the download
4. If blocked, it shows a visual indication to the user
5. Uses `pendingDownloads` to store and manage download information

## API Integration

The extension integrates with a URL classification API at:
`http://localhost:5000/v1/api/urlfiltering`

The API expects a POST request with the URL to check and returns classification details.
