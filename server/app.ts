import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import express from 'express';
import got from 'got';
import moment from 'moment';

import { MediathekManager } from './MediathekManager';
import { RSSFeedGenerator } from './RSSFeedGenerator';
import { SearchEngine } from './SearchEngine';
import { SubtitleConversionError, toWebVtt } from './SubtitleConverter';
import { getValkeyClient, initializeValkey } from './ValKey';
import { WatchPartyRegistry } from './WatchPartyRegistry';
import { attachWatchPartySocket, WATCH_PARTY_PATH } from './WatchPartySocket';
import { config } from './config';
import { VALKEY_KEYS } from './keys';

const VALKEY_SUBTITLE_CACHE = 'mvw:subtitleCache';

/** Subtitles above this size are served but not cached, to keep the Valkey hash bounded. */
const MAX_CACHED_SUBTITLE_BYTES = 512 * 1024;

(async () => {
  await initializeValkey();
  const valkey = getValkeyClient();

  const app = express();

  const indexHtmlPath = path.join(__dirname, '/client/index.html');
  let indexHtmlContent: string;

  try {
    indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');

    if (config.injectHtmlPath && config.injectHtmlPath.length > 0) {
      const injectHtml = fs.readFileSync(config.injectHtmlPath, 'utf-8');
      indexHtmlContent = indexHtmlContent.replace('</head>', `${injectHtml}\n</head>`);
    }
  }
  catch (error) {
    console.error(`Failed to read or process index.html: ${error}`);
    process.exit(1);
  }

  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

  const searchEngine = new SearchEngine(config.opensearch);
  await searchEngine.waitForConnection();

  const mediathekManager = new MediathekManager();
  const rssFeedGenerator = new RSSFeedGenerator(searchEngine);
  const watchPartyRegistry = new WatchPartyRegistry();

  let filmlisteTimestamp = await mediathekManager.getCurrentFilmlisteTimestamp();
  let totalEntries = await valkey.scard(VALKEY_KEYS.CURRENT_FILMLISTE);

  mediathekManager.on('state', (state) => {
    if (state == null) {
      return;
    }

    console.log();
    console.log(state);
    console.log();
  });

  app.use(compression());

  app.use((_request, response, next) => {
    // const webSocketSource = (request.protocol === 'http' ? 'ws://' : 'wss://') + request.get('host');
    // const orfCdn = 'https://apasfiis.sf.apa.at https://varorfvod.sf.apa.at';
    // const srfCdn = 'https://hdvodsrforigin-f.akamaihd.net http://hdvodsrforigin-f.akamaihd.net https://srfvodhd-vh.akamaihd.net';

    response.set({
      // 'Content-Security-Policy': `default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self' data:; connect-src 'self' ${webSocketSource} ${orfCdn} ${srfCdn}; media-src * blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none';`,
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });

    next();
  });

  app.use(async (req, res, next) => {
    if ((req.url == '/') || (req.url == '/index.html')) {
      res.send(indexHtmlContent);
    }
    else {
      next();
    }
  });

  app.use('/', express.static(path.join(__dirname, '/client'), { index: false }));
  app.use('/api', express.json(), express.text());

  app.get('/ads.txt', (_req, res) => {
    res.send(config.adsText);
  });

  app.get('/stats', (_req, res) => {
    const partyStats = config.watchParty
      ? `Watch parties: ${watchPartyRegistry.partyCount} (${watchPartyRegistry.memberCount} clients)`
      : 'Watch parties: disabled';

    res.send(`Server is up and running.
${partyStats}`);
  });

  app.get('/feed', async (req, res) => {
    try {
      const result = await rssFeedGenerator.createFeed(req.protocol + '://' + req.get('host') + req.originalUrl);

      res.set('Content-Type', 'text/xml');
      res.send(result);

    }
    catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      res.status(500).send(errorMessage);
    }
  });

  app.get('/api/contact-info', (_req, res) => {
    res.json(config.contact);
  });

  app.get('/api/channels', async (_req, res) => {
    try {
      const channels = await searchEngine.getChannels();
      res.json({
        error: null,
        channels: channels
      });
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      res.status(500).json({
        error: errorMessage,
        channels: null
      });
    }
  });

  app.get('/api/topics', async (req, res) => {
    const channel = req.query.channel as string | undefined;
    try {
      const topics = await searchEngine.getTopics(channel);
      res.json({
        error: null,
        topics: topics
      });
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      res.status(500).json({
        error: errorMessage,
        topics: null
      });
    }
  });

  app.get('/api/content-length', async (req, res) => {
    const url = req.query.url as string;

    if (!url) {
      res.status(400).send('URL parameter is missing');
      return;
    }

    try {
      const cachedResult = await valkey.hget('mvw:contentLengthCache', url);

      if (cachedResult) {
        res.send(cachedResult);
      }
      else {
        const response = await got.head(url);
        const contentLength = Number(response.headers['content-length'] || -1);
        res.send(contentLength.toString());
        await valkey.hset('mvw:contentLengthCache', { [url]: contentLength.toString() });
      }
    }
    catch (error) {
      res.send('-1');
    }
  });

  app.post('/api/party', (req, res) => {
    if (!config.watchParty) {
      res.status(404).json({ error: 'watch party is disabled', party: null });
      return;
    }

    // The per-IP limit deliberately covers hosting only: any number of clients may join from
    // anywhere, so several people behind one NAT can still watch together.
    const hostIp = req.ip ?? 'unknown';
    const created = watchPartyRegistry.createParty(hostIp);

    if ('error' in created) {
      res.status(503).json({ error: 'too many active parties, try again later', party: null });
      return;
    }

    // A reverse proxy serving the app from a subfolder can advertise it via X-Forwarded-Prefix;
    // the browser builds its own link from the page URL, so this is for API consumers.
    const forwardedPrefix = req.get('x-forwarded-prefix') ?? '';
    const prefix = /^\/[\w\-./]*$/.test(forwardedPrefix) ? forwardedPrefix.replace(/\/$/, '') : '';

    res.json({
      error: null,
      party: {
        partyId: created.partyId,
        hostToken: created.hostToken,
        // Carries the party's first single-use invite; without one the link is not usable.
        inviteToken: created.inviteToken,
        inviteUrl: `${req.protocol}://${req.get('host')}${prefix}/#party=${created.partyId}&invite=${created.inviteToken}`
      }
    });
  });

  app.get('/api/party/:id', (req, res) => {
    if (!config.watchParty) {
      res.status(404).json({ error: 'watch party is disabled', exists: false, hasVideo: false });
      return;
    }

    const partyId = req.params.id;
    const invite = req.query.invite as string | undefined;

    res.json({
      error: null,
      exists: watchPartyRegistry.has(partyId),
      hasVideo: watchPartyRegistry.hasVideo(partyId),
      // Probing does not consume the invite; claiming happens on the socket upgrade.
      inviteClaimable: (typeof invite == 'string') && watchPartyRegistry.isInviteClaimable(partyId, invite)
    });
  });

  app.get('/api/subtitle', async (req, res) => {
    // Addressed by entry id rather than by URL on purpose: resolving the subtitle URL from the
    // index keeps this from becoming an open GET proxy.
    const id = req.query.id as string;

    res.header('Access-Control-Allow-Origin', '*');

    if (!id) {
      res.status(400).send('id parameter is missing');
      return;
    }

    try {
      const cached = await valkey.hget(VALKEY_SUBTITLE_CACHE, id);

      if (cached != null) {
        if (cached.length == 0) {
          res.status(404).send('no usable subtitle for this entry');
          return;
        }

        res.type('text/vtt; charset=utf-8').send(cached.toString());
        return;
      }

      const entry = await searchEngine.getEntry(id);
      const subtitleUrl = entry?.url_subtitle;

      if (!subtitleUrl) {
        await valkey.hset(VALKEY_SUBTITLE_CACHE, { [id]: '' });
        res.status(404).send('entry has no subtitle');
        return;
      }

      const response = await got.get(subtitleUrl, { timeout: { request: 15000 }, retry: { limit: 1 } });
      const webVtt = toWebVtt(response.body);

      res.type('text/vtt; charset=utf-8').send(webVtt);

      if (webVtt.length <= MAX_CACHED_SUBTITLE_BYTES) {
        await valkey.hset(VALKEY_SUBTITLE_CACHE, { [id]: webVtt });
      }
    }
    catch (error) {
      if (error instanceof SubtitleConversionError) {
        // Unconvertible subtitles are cached as a negative result so we do not refetch them.
        await valkey.hset(VALKEY_SUBTITLE_CACHE, { [id]: '' }).catch(() => undefined);
        res.status(404).send(error.message);
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      res.status(502).send(errorMessage);
    }
  });

  app.post('/api/entries', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
      const ids: string[] = req.body;
      const entries = await searchEngine.getEntries(ids);

      res.status(200).json({
        result: {
          results: entries
        },
        err: null
      });

      console.log(moment().format('HH:mm') + ' - entries api used');
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      res.status(400).json({
        result: null,
        err: [errorMessage]
      });
    }
  });

  app.post('/api/query', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    let query;
    try {
      query = (typeof req.body == 'string') ? JSON.parse(req.body) : req.body;
    }
    catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred';
      res.status(400).json({
        result: null,
        err: [errorMessage]
      });
      return;
    }

    handleQuery(query, res);
  });

  app.get('/api/query', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    let query;
    try {
      query = JSON.parse(req.query.query as string);
    }
    catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred';
      res.status(400).json({
        result: null,
        err: [errorMessage]
      });
      return;
    }

    handleQuery(query, res);
  });

  async function handleQuery(query: object, response: express.Response): Promise<void> {
    const begin = process.hrtime();
    try {
      const result = await searchEngine.search(query);
      const end = process.hrtime(begin);
      const searchEngineTime = (end[0] * 1e3 + end[1] / 1e6).toFixed(2);

      const queryInfo = {
        filmlisteTimestamp: filmlisteTimestamp,
        searchEngineTime: searchEngineTime,
        resultCount: result.result.length,
        totalResults: result.totalResults,
        totalRelation: result.totalRelation,
        totalEntries,
      };

      response.status(200).json({
        result: {
          results: result.result,
          queryInfo: queryInfo
        },
        err: null
      });

      console.log(moment().format('HH:mm') + ' - search api used');

    }
    catch (err) {
      const error = err as Error;
      if (error.message == 'cannot query while indexing') {
        response.status(503);
      }
      else {
        response.status(500);
      }

      response.json({
        result: null,
        err: [error.message]
      });
    }
  }

  const httpServer = app.listen(config.webserverPort, () => {
    console.log('server listening on *:' + config.webserverPort);
    console.log();
  });

  if (config.watchParty) {
    attachWatchPartySocket(httpServer, watchPartyRegistry);
    console.log('watch party socket listening on ' + WATCH_PARTY_PATH);
  }

  process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));

  async function updateLoop() {
    try {
      const updated = await mediathekManager.updateFilmlisteIfUpdateAvailable();

      if (updated) {
        filmlisteTimestamp = await mediathekManager.getCurrentFilmlisteTimestamp();
        totalEntries = await valkey.scard(VALKEY_KEYS.CURRENT_FILMLISTE);
      }
    }
    catch (error) {
      console.error(error);
    }
    finally {
      setTimeout(updateLoop, 3 * 60 * 1000).unref();
    }
  }

  if (config.index) {
    setImmediate(updateLoop);
  }
})();

process.on('SIGINT', () => {
  console.log("Caught SIGINT - exiting...");
  process.exit(0);
});
