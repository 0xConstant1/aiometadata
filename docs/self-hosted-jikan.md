# Self-Hosted Jikan API

MAL catalogs, MAL search and MAL anime metadata come from [MyAnimeList](https://myanimelist.net/) via the [Jikan](https://jikan.moe/) API. The public Jikan API shut down on October 1, 2026, so the addon now defaults to [Tenrai](https://tenrai.org), a public Jikan-compatible API limited to 120 requests a minute per IP. For more headroom, run your own Jikan instance and point the addon at it with a single environment variable:

```env
JIKAN_API_BASE=http://jikan_rest:8080/v4
```

Set this on the `aiometadata` service (in its `.env`). When both containers share a Docker network, the addon reaches Jikan by container name — no public exposure needed.

## Compose stack

Jikan runs as four services: `jikan_rest` serves the API, MongoDB holds the data, Redis caches responses, and Typesense answers `?q=`. [Search](#search) covers how the last two divide the work.

Save as `apps/jikan-rest/compose.yaml` (or merge into your stack):

```yaml
secrets:
  jikan_db_username:       { file: ./secrets/db_username.txt }
  jikan_db_password:       { file: ./secrets/db_password.txt }
  jikan_db_admin_username: { file: ./secrets/db_admin_username.txt }
  jikan_db_admin_password: { file: ./secrets/db_admin_password.txt }
  jikan_redis_password:    { file: ./secrets/redis_password.txt }
  jikan_typesense_api_key: { file: ./secrets/typesense_api_key.txt }

services:
  jikan_rest:
    image: docker.io/jikanme/jikan-rest:latest
    container_name: jikan_rest
    hostname: jikan-rest-api
    user: "10001:10001"
    restart: unless-stopped
    env_file: [ .env.compose ]
    secrets: [ jikan_db_username, jikan_db_password, jikan_redis_password, jikan_typesense_api_key ]
    volumes:
      - ./RepositoryQuery.php:/app/app/Support/RepositoryQuery.php:ro
    expose: [ 8080 ]
    healthcheck:
      test: ["CMD-SHELL", "wget --spider -q 'http://127.0.0.1:2114/health?plugin=http'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      jikan_mongo:     { condition: service_healthy }
      jikan_redis:     { condition: service_healthy }
      jikan_typesense: { condition: service_started }

  jikan_mongo:
    image: docker.io/mongo:focal
    container_name: jikan_mongo
    hostname: jikan_mongo
    restart: unless-stopped
    command: "--wiredTigerCacheSizeGB 0.5"
    secrets: [ jikan_db_username, jikan_db_password, jikan_db_admin_username, jikan_db_admin_password ]
    environment:
      MONGO_INITDB_ROOT_USERNAME_FILE: /run/secrets/jikan_db_admin_username
      MONGO_INITDB_ROOT_PASSWORD_FILE: /run/secrets/jikan_db_admin_password
      MONGO_INITDB_DATABASE: jikan_admin
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/mongo:/data/db
      - ./mongo-init.js:/docker-entrypoint-initdb.d/mongo-init.js:ro
    healthcheck:
      test: ["CMD-SHELL", "mongosh mongodb://localhost:27017 --quiet --eval 'db.runCommand(\"ping\").ok'"]
      interval: 30s
      timeout: 10s
      retries: 5

  jikan_redis:
    image: docker.io/redis:6-alpine
    container_name: jikan_redis
    hostname: jikan_redis
    restart: unless-stopped
    secrets: [ jikan_redis_password ]
    command: ["/bin/sh", "-c", "redis-server --requirepass \"$$(cat /run/secrets/jikan_redis_password)\" --appendonly yes"]
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/redis:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$(cat /run/secrets/jikan_redis_password)\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 5

  jikan_typesense:
    image: docker.io/typesense/typesense:0.24.1
    container_name: jikan_typesense
    hostname: jikan_typesense
    restart: unless-stopped
    entrypoint: /bin/sh
    secrets: [ jikan_typesense_api_key ]
    command: ["-c", "TYPESENSE_API_KEY=\"$$(cat /run/secrets/jikan_typesense_api_key)\" /opt/typesense-server --data-dir /data"]
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/typesense:/data
```

Save the container config as `apps/jikan-rest/.env.compose`:

```env
APP_DEBUG=false
LOG_LEVEL=info
APP_ENV=production
# Indexers self-call the API; must point at RoadRunner's port (8080), NOT the default port 80
APP_URL=http://127.0.0.1:8080
CACHING=true
CACHE_DRIVER=redis
REDIS_HOST=jikan_redis
REDIS_PASSWORD__FILE=/run/secrets/jikan_redis_password
DB_CONNECTION=mongodb
DB_HOST=jikan_mongo
DB_DATABASE=jikan
DB_USERNAME__FILE=/run/secrets/jikan_db_username
DB_ADMIN__FILE=/run/secrets/jikan_db_username
DB_PASSWORD__FILE=/run/secrets/jikan_db_password
SCOUT_DRIVER=typesense
SCOUT_QUEUE=false
TYPESENSE_HOST=jikan_typesense
TYPESENSE_PORT=8108
TYPESENSE_API_KEY__FILE=/run/secrets/jikan_typesense_api_key
CORS_MIDDLEWARE=true
MICROCACHING=true
MICROCACHING_EXPIRE=60
# Only needed if you raise MAL_PAGE_SIZE on the addon. Both default to 25.
MAX_RESULTS_PER_PAGE=50
```

Save the MongoDB init script as `apps/jikan-rest/mongo-init.js`. It creates the app user and the `anime` indexes the squash migration is supposed to create but does not reliably apply. Building them here means they exist before the indexer inserts its first row, so `mal_id` stays unique and queries never fall back to collection scans:

```js
const userToCreate = fs.readFileSync('/run/secrets/jikan_db_username', 'utf8').trim();
const userPassword = fs.readFileSync('/run/secrets/jikan_db_password', 'utf8').trim();
db = db.getSiblingDB("admin");
db.createUser({ user: userToCreate, pwd: userPassword, roles: [{ role: "readWrite", db: "jikan" }] });
db = db.getSiblingDB("jikan");
db.createUser({ user: userToCreate, pwd: userPassword, roles: [{ role: "readWrite", db: "jikan" }] });

// Mirrors database/migrations/2022_12_04_210448_squash.php.
const fields = [
  "aired", "airing", "episodes", "members", "favorites", "popularity", "rank",
  "rating", "score", "scored_by", "status", "type", "source",
  "title", "title_english", "title_japanese", "title_synonyms",
  "demographics.mal_id", "explicit_genres.mal_id", "genres.mal_id",
  "licensors.mal_id", "producers.mal_id", "studios.mal_id", "themes.mal_id",
  "aired.from", "aired.to",
];
fields.forEach(f => db.anime.createIndex({ [f]: 1 }, { name: f }));
db.anime.createIndex({ mal_id: 1 }, { name: "mal_id", unique: true });
db.anime.createIndex(
  { title: "text", title_japanese: "text" },
  { name: "search", weights: { title: 50, title_japanese: 5 } }
);
print("anime indexes created: " + db.anime.getIndexes().length);
```

This only runs when the data directory is empty, so it covers new stacks. Existing ones need the [manual pass](#mongodb-indexes) below.

## Query builder patch (required)

`queryable()` memoises its builder on a singleton repository, and RoadRunner workers outlive requests, so a worker ANDs together the `where` clauses of everything it has served. The symptom is identical URLs returning different counts, and a `sfw=true` that returns nothing. Save as `apps/jikan-rest/RepositoryQuery.php`:

```php
<?php

namespace App\Support;

use App\Contracts\RepositoryQuery as RepositoryQueryContract;
use Illuminate\Contracts\Database\Query\Builder;
use Illuminate\Support\Collection;
use Laravel\Scout\Builder as ScoutBuilder;

class RepositoryQuery extends RepositoryQueryBase implements RepositoryQueryContract
{
    public function filter(Collection $params): Builder|ScoutBuilder
    {
        // queryable() memoises the builder. Repositories are singletons that outlive
        // a request under RoadRunner, so the memoised instance accumulates every
        // previous request's where clauses (genre A AND genre B AND ... => 0 results).
        // Always start from a fresh builder.
        return $this->queryable(true)->filter($params);
    }

    public function search(string $keywords, ?\Closure $callback = null): ScoutBuilder
    {
        return $this->searchable($keywords, $callback, true);
    }

    public function where(string $key, mixed $value): Builder
    {
        return $this->queryable(true)->where($key, $value);
    }
}
```

Create this file before the first `docker compose up -d`, otherwise Docker creates a directory at that mount path.

Generate the secret files (note the `chmod 644` — Mongo and the app run as non-root and must be able to read the bind-mounted secrets):

```bash
cd apps/jikan-rest && mkdir -p secrets
echo -n "jikan"        > secrets/db_username.txt
echo -n "jikanadmin"   > secrets/db_admin_username.txt
openssl rand -hex 24 | tr -d '\n' > secrets/db_password.txt
openssl rand -hex 24 | tr -d '\n' > secrets/db_admin_password.txt
openssl rand -hex 24 | tr -d '\n' > secrets/redis_password.txt
openssl rand -hex 24 | tr -d '\n' > secrets/typesense_api_key.txt
chmod 644 secrets/*.txt
```

Then start it: `docker compose up -d`

## Search

Jikan splits a search in two. Typesense matches `?q=`, and MongoDB applies everything else: `SearchEngineSearchService` hands the filters to Scout's `query()` hook, which runs them against the Eloquent builder that hydrates the results. So `genres`, `genres_exclude`, `producers`, `sfw`, `min_score`, `max_score`, `start_date` and `end_date` behave exactly as they would with no search engine at all, while `?q=` gets typo tolerance and matching on part of a word. The compose stack above is already wired this way, and no part of it needs patching.

The other option is `SCOUT_DRIVER=null`, which sends the whole query to `MongoSearchService` instead. It is not worth taking: `$text` indexes whole tokens and tolerates no typos, so `999` never reaches *Lv999 no Murabito*, and a misspelled title returns nothing.

### Coming from an earlier version of this guide

Revisions of this section before August 2026 recommended exactly that, through a `SCOUT_DRIVER: '"null"'` entry under `environment:` and a patched `MongoSearchService.php` mount. Both are now unnecessary — delete them from `compose.yaml`, keeping the `RepositoryQuery.php` mount, and recreate the container:

```bash
docker compose up -d jikan_rest
```

`SCOUT_DRIVER=typesense` in `.env.compose` then takes effect. The `MongoSearchService.php` file itself can be deleted once nothing mounts it.

### Populating the index

Scout keeps Typesense current through model observers, and the `null` driver disables them. Any stack that ran with search off therefore has an index that is empty or frozen at the day it was switched off, and needs a one-off import per model:

```bash
for m in Anime Manga Character Person Club Magazine Producers; do
  docker exec jikan_rest php artisan scout:import "App\\$m"
done
```

Thirty thousand anime take about a minute. After that the observers keep the index in step with the indexer commands, so this is not a recurring job.

Importing a model whose Mongo collection is still empty creates a collection with no fields, and searching it then returns HTTP 500 rather than an empty list, because the sort and query-by fields the model names do not exist. Run the import after the corresponding indexer, or create the collection with the fields up front. Typesense's `.*` auto field fills in the rest once real documents arrive:

```bash
docker exec jikan_rest php -r '
$key = trim(file_get_contents("/run/secrets/jikan_typesense_api_key"));
$auto = ["name" => ".*", "type" => "auto", "optional" => true];
// A query of three characters or fewer is sorted by the title attribute, which a
// string field only allows when it is declared sortable.
$string = fn($n, $sort = false) => ["name" => $n, "type" => "string", "optional" => true, "sort" => $sort];
$strings = fn($n) => ["name" => $n, "type" => "string[]", "optional" => true];
$int = fn($n) => ["name" => $n, "type" => "int64", "optional" => true];
$schemas = [
  "manga_index" => [$auto, $string("title", true), $string("title_transformed"),
    $string("title_english"), $string("title_english_transformed"),
    $string("title_japanese"), $string("title_japanese_transformed"),
    $strings("title_synonyms"), $int("popularity"), $int("rank")],
  "characters_index" => [$auto, $string("name", true), $string("name_kanji"), $int("member_favorites")],
  "people_index" => [$auto, $string("name", true), $string("given_name"), $string("family_name"),
    $strings("alternate_names"), $int("member_favorites")],
];
foreach ($schemas as $name => $fields) {
  $c = curl_init("http://jikan_typesense:8108/collections");
  curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["X-TYPESENSE-API-KEY: $key", "Content-Type: application/json"],
    CURLOPT_POSTFIELDS => json_encode(["name" => $name, "fields" => $fields])]);
  curl_exec($c);
  echo $name, " ", curl_getinfo($c, CURLINFO_HTTP_CODE), PHP_EOL;
}'
```

Restart `jikan_rest` afterwards. Its collection descriptor caches a schema per RoadRunner worker, so workers started before an index existed keep serving the old answer.

### Result ordering

`TYPESENSE_TEXT_MATCH_BUCKETS` (default 1) groups results into relevance bands before the secondary sort applies. Raising it leans the order towards popularity, lowering it towards the exact wording of the query.

## MongoDB indexes

New stacks get these from `mongo-init.js` above and can skip this section. Stacks built before that ran are likely sitting on a single `_id_` index, which means collection scans and genre requests that time out once the catalog is seeded. `mongo-init.js` will not fix them, since it only fires on an empty data directory. Check the count:

```bash
docker exec jikan_mongo mongosh "mongodb://<admin_user>:<admin_pass>@localhost/admin" \
  --quiet --eval 'print(db.getSiblingDB("jikan").anime.getIndexes().length)'
```

You want 29. If it says 1, save this as `apps/jikan-rest/jikan-indexes.js`:

```js
// Mirrors database/migrations/2022_12_04_210448_squash.php. Safe to re-run.
const d = db.getSiblingDB("jikan");
const fields = [
  "aired", "airing", "episodes", "members", "favorites", "popularity", "rank",
  "rating", "score", "scored_by", "status", "type", "source",
  "title", "title_english", "title_japanese", "title_synonyms",
  "demographics.mal_id", "explicit_genres.mal_id", "genres.mal_id",
  "licensors.mal_id", "producers.mal_id", "studios.mal_id", "themes.mal_id",
  "aired.from", "aired.to",
];
fields.forEach(f => d.anime.createIndex({ [f]: 1 }, { name: f }));
try {
  d.anime.createIndex({ mal_id: 1 }, { name: "mal_id", unique: true });
} catch (e) {
  print("mal_id index failed, see the duplicate cleanup below: " + e.codeName);
}
d.anime.createIndex(
  { title: "text", title_japanese: "text" },
  { name: "search", weights: { title: 50, title_japanese: 5 } }
);
print("anime indexes: " + d.anime.getIndexes().length);
```

and pipe it in:

```bash
cd apps/jikan-rest
docker exec -i jikan_mongo mongosh \
  "mongodb://$(cat secrets/db_admin_username.txt):$(cat secrets/db_admin_password.txt)@localhost/admin" \
  --quiet < jikan-indexes.js
```

Run it before the full catalog indexer if you can, it is cheaper on an empty collection.

If it prints 28 and the `mal_id` line reported `DuplicateKey`, the indexer stored the same anime twice, which it can do freely while no unique index exists. Save this as `apps/jikan-rest/jikan-dedupe.js` to delete the extra copies and retry the index:

```js
const d = db.getSiblingDB("jikan");
d.anime.aggregate([
  { $group: { _id: "$mal_id", ids: { $push: "$_id" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
], { allowDiskUse: true }).forEach(g => {
  g.ids.slice(1).forEach(id => d.anime.deleteOne({ _id: id }));
  print("mal_id " + g._id + ": removed " + (g.n - 1));
});
d.anime.createIndex({ mal_id: 1 }, { name: "mal_id", unique: true });
print("anime indexes: " + d.anime.getIndexes().length);
```

Pipe it in the same way:

```bash
cd apps/jikan-rest
docker exec -i jikan_mongo mongosh \
  "mongodb://$(cat secrets/db_admin_username.txt):$(cat secrets/db_admin_password.txt)@localhost/admin" \
  --quiet < jikan-dedupe.js
```

It keeps the first copy of each and drops the rest. The unique index then stops the indexer creating more.

## Seeding the index

Direct lookups (e.g. `/v4/anime/1`) work immediately by scraping MAL on demand. But **search, `seasons`, `top`, and genre catalogs are served from Jikan's own database, which starts empty** and must be populated. Run the indexers (they scrape MAL and are rate-limited):

```bash
# Fast metadata
docker exec jikan_rest php artisan indexer:genres
docker exec jikan_rest php artisan indexer:producers
docker exec jikan_rest php artisan indexer:anime-current-season
docker exec jikan_rest php artisan indexer:anime-schedule

# Full catalog (~30k anime — runs for hours; --delay is seconds between requests, default 3)
docker exec -d jikan_rest sh -c 'php artisan indexer:anime --delay=1 >> /tmp/indexer-anime.log 2>&1'
```

Lower `--delay` speeds it up but increases the risk of MyAnimeList rate-limiting your IP. The container self-runs a scheduler that keeps data fresh after the initial seed. Check progress with `docker exec jikan_rest tail -f /tmp/indexer-anime.log`.

## Optional: worker-leak mitigation

The bundled RoadRunner app server can accumulate CPU/memory over time. To recycle workers gracefully (no restart needed), mount a custom `.rr.yaml` over `/app/.rr.yaml` that adds lifecycle limits — give the queue worker `queue:work --max-time=3600 --max-jobs=1000 --memory=256`, set the HTTP pool `supervisor.ttl: 3600s`, and cap `num_workers`. Add `- ./rr.yaml:/app/.rr.yaml:ro` to the `jikan_rest` volumes.
