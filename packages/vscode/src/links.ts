import { STORE_CHROME_EXTENSION_ID } from '@codealong/protocol';

export const REPOSITORY_URL = 'https://github.com/sebastianingebrigtsen/codealong';

/** Where users get the Chrome extension: the Web Store once it is listed, the README until then. */
export const CHROME_EXTENSION_URL = STORE_CHROME_EXTENSION_ID
  ? `https://chromewebstore.google.com/detail/${STORE_CHROME_EXTENSION_ID}`
  : `${REPOSITORY_URL}#installation`;

export const PRIVACY_URL = `${REPOSITORY_URL}/blob/main/docs/PRIVACY.md`;
