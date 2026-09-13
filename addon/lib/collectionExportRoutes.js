const consola = require('consola');
const database = require('./database');
const { toFusionWidgets } = require('./collectionBuilder/fusionExport');
const { toNuvioCollections } = require('./collectionBuilder/nuvioExport');
const { buildBlueprintLookup } = require('./collectionBuilder/blueprintLookup');
const { proxyCollectionImages } = require('./collectionBuilder/imageProxy');
const { getCollectionImagePrefix } = require('./posterCache/config');
const { isAliasFeatureEnabled, getAliasForUuid } = require('./aliasResolver');
const buildInfo = require('./buildInfo');

const logger = consola.withTag('CollectionExport');

/** Alias holders get their alias in the URL, matching how install URLs are built. */
function manifestIdentifier(userUUID) {
  if (!isAliasFeatureEnabled()) return userUUID;
  return getAliasForUuid(userUUID) || userUUID;
}

function resolveBaseUrl(req) {
  const hostEnv = process.env.HOST_NAME;
  if (hostEnv) {
    return hostEnv.startsWith('http') ? hostEnv : `https://${hostEnv}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * Both consumers record which addon a source came from. Nuvio keys off the
 * manifest id plus a base URL, Fusion off the manifest URL itself.
 */
function buildIdentity(req, userUUID, config, tag) {
  const baseUrl = resolveBaseUrl(req);
  const identifier = manifestIdentifier(userUUID);
  const addonBaseUrl = `${baseUrl}/stremio/${identifier}`;
  const query = tag ? `?tag=${encodeURIComponent(tag)}` : '';
  return {
    addonId: buildInfo.name,
    addonBaseUrl,
    addonName: (config.addonName || '').trim() || 'AIOMetadata',
    manifestUrl: `${addonBaseUrl}/manifest.json${query}`,
  };
}

function readTag(req) {
  return typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
}

async function loadEntries(userUUID) {
  const config = await database.getUserConfig(userUUID);
  if (!config) return { error: 'notFound' };
  let entries = Array.isArray(config.collections) ? config.collections : [];
  const prefix = config.collectionImagesViaCache ? getCollectionImagePrefix() : '';
  if (prefix) entries = proxyCollectionImages(entries, prefix);
  return { config, entries };
}

function sendJson(res, payload) {
  // These are pasted into another app's importer, so they must never be cached
  // stale after the user edits their collections.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).send(JSON.stringify(payload, null, 2));
}

function register(addon) {
  addon.get('/stremio/:userUUID/fusion-widgets.json', async (req, res) => {
    const { userUUID } = req.params;
    try {
      const { config, entries, error } = await loadEntries(userUUID);
      if (error === 'notFound') {
        return res.status(404).json({ err: 'User configuration not found.' });
      }

      const identity = buildIdentity(req, userUUID, config, readTag(req));
      const blueprints = buildBlueprintLookup(config.catalogs);
      const { output } = toFusionWidgets(entries, identity, { blueprints });
      logger.debug(`Served ${output.widgets.length} Fusion widgets for ${userUUID.substring(0, 8)}`);
      sendJson(res, output);
    } catch (err) {
      logger.error(`Fusion widget export failed for ${userUUID}:`, err.message);
      res.status(500).json({ err: 'Failed to build widgets.' });
    }
  });

  addon.get('/stremio/:userUUID/nuvio-collections.json', async (req, res) => {
    const { userUUID } = req.params;
    try {
      const { config, entries, error } = await loadEntries(userUUID);
      if (error === 'notFound') {
        return res.status(404).json({ err: 'User configuration not found.' });
      }

      const identity = buildIdentity(req, userUUID, config, readTag(req));
      const blueprints = buildBlueprintLookup(config.catalogs);
      const { output } = toNuvioCollections(entries, identity, blueprints);
      logger.debug(`Served ${output.length} Nuvio collections for ${userUUID.substring(0, 8)}`);
      sendJson(res, output);
    } catch (err) {
      logger.error(`Nuvio collection export failed for ${userUUID}:`, err.message);
      res.status(500).json({ err: 'Failed to build collections.' });
    }
  });
}

module.exports = { register, buildIdentity, manifestIdentifier };
