export const CONFIG = {
  // Create an OAuth 2.0 Client ID in Google Cloud Console (Web application).
  // Add Authorized JavaScript origins for your site (ex: http://localhost:5173).
  GOOGLE_CLIENT_ID: "PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com",

  // Minimal scope for app-managed files:
  // - drive.file: read/write files created/opened by the app
  // Note: Sharing permissions require permission changes on those files.
  SCOPES: "https://www.googleapis.com/auth/drive.file",

  APP_FOLDER_NAME: "MyShoppingLists",
  FILE_MIME: "application/json",
  FILE_NAME_PREFIX: "list_",

  // App markers for Drive file discovery
  APP_PROPERTY_KEY: "app",
  APP_PROPERTY_VALUE: "shoppinglist",
};