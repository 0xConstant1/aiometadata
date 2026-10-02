# LumiereDB

LumiereDB is a self-hosted API built on IMDb's datasets. It downloads the data and builds its own index, so searches and lists come back fast without calling a third-party API. Connect one to AIOMetadata and you get:

- **LumiereDB Search**: a movie and series search provider. It understands typos (`interstelar`), run-together words (`spiderman`), sequel numerals (`gladiator 2`), a trailing year (`dune 2021`) and acronyms of very popular titles (`tdk`, `lotr`). Results keep LumiereDB's ranking.
- **LumiereDB People Search**: type a full name and get the movies or series that person is known for.
- **LumiereDB Popular** and **LumiereDB Trending**: catalogs for movies and series, filterable by LumiereDB's genres. Popular goes 500 titles deep and Trending 100. Both leave out thinly voted and poorly rated titles.

LumiereDB only returns IMDb ids. AIOMetadata builds every result with your usual metadata providers, so posters, art, ratings and your filters work as everywhere else.

LumiereDB's data comes from [IMDb's non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/): use it for personal, non-commercial purposes only.

## Requirements

About 5 GB of free disk. The IMDb downloads take about 1.8 GB and the live index about 1 GB; a rebuild briefly holds a second index plus a temporary work area beside it.

## Compose stack

Add LumiereDB to the same compose file as `aiometadata`, so the two share a Docker network. AIOMetadata reaches it by container name, so it doesn't need to be exposed to the internet.

```yaml
services:
  lumiere-db:
    image: ghcr.io/0xconstant1/lumiere-db:latest
    container_name: lumiere-db
    restart: unless-stopped
    stop_grace_period: 75s
    user: "${PUID}:${PGID}"
    expose:
      - 8000
    env_file:
      - .env
    volumes:
      - ${DOCKER_DATA_DIR}/lumiere-db:/data
    profiles:
      - lumiere-db
      - all
```

- `stop_grace_period: 75s` gives a rebuild time to finish writing on `docker compose down`.
- The container runs as `PUID:PGID`, so create the data folder and give it to that user first:

  ```bash
  mkdir -p "$DOCKER_DATA_DIR/lumiere-db"
  chown "$PUID:$PGID" "$DOCKER_DATA_DIR/lumiere-db"
  ```

- The service is behind the `lumiere-db` and `all` profiles, so start it with:

  ```bash
  docker compose --profile lumiere-db up -d
  ```

## Point AIOMetadata at it

Add this to the `aiometadata` service's `.env` and restart the addon:

```env
LUMIERE_API_BASE=http://lumiere-db:8000
```

When `LUMIERE_API_BASE` is empty, every LumiereDB option is hidden. A configuration that picked LumiereDB falls back to the default provider, and its LumiereDB catalogs are switched off.

## First start

On first start LumiereDB downloads about 2 GB from IMDb and builds its index, which takes a while. Until then, LumiereDB searches and catalogs come back empty. Check progress with:

```bash
docker compose exec lumiere-db wget -qO- http://localhost:8000/readyz
```

It returns `{"status":"not_ready",...}` until the first build is published, then `200`. After that LumiereDB checks IMDb hourly and rebuilds in the background when the data changes. The old index keeps serving until the new one swaps in.

## Turn it on in AIOMetadata

Once `LUMIERE_API_BASE` is set, open `/configure`:

- **Search**: pick **LumiereDB Search** as the movie or series provider, and **LumiereDB People Search** for people search.
- **Catalogs**: enable **LumiereDB Popular** and **LumiereDB Trending** for movies and series, and choose a genre if you like.

## Addon settings

All of these can be set in `.env` or changed from the dashboard.

| Variable | Default | What it does |
|---|---|---|
| `LUMIERE_API_BASE` | *(empty)* | LumiereDB address. Empty hides every LumiereDB option. |
| `LUMIERE_SEARCH_TIMEOUT_MS` | `5000` | How long to wait for LumiereDB before giving up on a search or list. |
| `LUMIERE_SEARCH_TTL_SECONDS` | `86400` | How long a query's LumiereDB results are cached, shared by every user. `0` turns caching off. |
| `LUMIERE_SEARCH_RESULT_LIMIT` | `12` | How many search results to build (1–50). Each one costs a TMDB lookup. |
| `LUMIERE_PEOPLE_PAGE_SIZE` | `20` | How many of a person's titles each people-search page builds (1–50). Each one costs a TMDB lookup. |

The genre list for Popular and Trending is cached for 30 days. The catalogs follow each catalog's own cache lifetime.

## LumiereDB settings worth knowing

These go in the `.env` LumiereDB reads.

| Variable | Default | Why you'd set it |
|---|---|---|
| `ETL_REBUILD_WINDOW` | *(any time)* | Hold routine rebuilds to a window such as `02:00-06:00`, so they run during quiet hours. |
| `TZ` | `UTC` | Time zone the rebuild window is read in. |

To rebuild immediately, without waiting for the next check:

```bash
docker compose exec lumiere-db /app/api rebuild
```

## Good to know

- **People search needs a full name.** `brad pitt` works, `pitt` alone doesn't. It returns the one person the name most likely means, and their best-known titles, not their full filmography.
- **Adult titles are always left out** of LumiereDB results.
