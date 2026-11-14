import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRunResults } from "./watchdog.mjs";

/**
 * fetchRunResults is the one piece of the watchdog that asks the Actions API
 * about a single run. The sentences in its comment (an expired artifact does
 * not count, an answer that is not OK stays unread, only the named artifact is
 * asked for) had no test. These replace fetch for one call and put it back.
 */

const VARIABLES = ["GITHUB_REPOSITORY", "GITHUB_TOKEN", "GITHUB_API_URL", "MURAQIB_RESULTS_ARTIFACT"];

async function withApi(responder, body, extraEnv = {}) {
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.GITHUB_TOKEN = "token";
  Object.assign(process.env, extraEnv);

  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return responder(String(url));
  };
  try {
    return await body(urls);
  } finally {
    globalThis.fetch = realFetch;
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const route = (artifacts, jobs) => url => (url.includes("/artifacts") ? artifacts : jobs);
const LIVE = { name: "test-results-json", expired: false };

test("the lookup asks for the results artifact by name on the right run, with the largest page", async () => {
  await withApi(route(reply(200, { artifacts: [LIVE] }), reply(200, { jobs: [] })), async urls => {
    await fetchRunResults({ id: 77 });
    assert.match(urls[0], /\/repos\/owner\/repo\/actions\/runs\/77\/artifacts\?name=test-results-json&per_page=100$/);
    assert.match(urls[1], /\/repos\/owner\/repo\/actions\/runs\/77\/jobs\?per_page=100$/);
  });
});

test("the configured artifact name is the one asked for", async () => {
  await withApi(
    route(reply(200, { artifacts: [] }), reply(200, { jobs: [] })),
    async urls => {
      await fetchRunResults({ id: 1 });
      assert.match(urls[0], /artifacts\?name=my-results&/);
    },
    { MURAQIB_RESULTS_ARTIFACT: "my-results" }
  );
});

test("a live artifact is listed and an expired one is not", async () => {
  const both = reply(200, { artifacts: [LIVE, { name: "old", expired: true }] });
  await withApi(route(both, reply(200, { jobs: [] })), async () => {
    assert.deepEqual((await fetchRunResults({ id: 1 })).artifacts, ["test-results-json"]);
  });

  const expiredOnly = reply(200, { artifacts: [{ name: "test-results-json", expired: true }] });
  await withApi(route(expiredOnly, reply(200, { jobs: [] })), async () => {
    assert.deepEqual((await fetchRunResults({ id: 1 })).artifacts, []);
  });
});

test("an artifacts answer that is not OK stays unread, whatever its body says", async () => {
  const broken = reply(500, { artifacts: [LIVE] });
  await withApi(route(broken, reply(200, { jobs: [] })), async () => {
    assert.equal((await fetchRunResults({ id: 1 })).artifacts, null);
  });
});

test("the first failed step across the jobs is named, and a job without steps does not break the lookup", async () => {
  const jobs = reply(200, {
    jobs: [
      { name: "no steps recorded" },
      {
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: "Install Playwright Chromium", conclusion: "failure" },
        ],
      },
      { steps: [{ name: "A later failure", conclusion: "failure" }] },
    ],
  });
  await withApi(route(reply(200, { artifacts: [] }), jobs), async () => {
    assert.equal((await fetchRunResults({ id: 1 })).failedStep, "Install Playwright Chromium");
  });
});

test("a jobs answer that is not OK leaves the step unnamed and the artifact list intact", async () => {
  await withApi(route(reply(200, { artifacts: [LIVE] }), reply(500, {})), async () => {
    const results = await fetchRunResults({ id: 1 });
    assert.equal(results.failedStep, null);
    assert.deepEqual(results.artifacts, ["test-results-json"]);
  });
});

test("steps that did not fail name nothing", async () => {
  const jobs = reply(200, {
    jobs: [
      {
        steps: [
          { name: "a", conclusion: "success" },
          { name: "b", conclusion: "skipped" },
          { name: "c", conclusion: "cancelled" },
          { name: "d", conclusion: null },
        ],
      },
    ],
  });
  await withApi(route(reply(200, { artifacts: [] }), jobs), async () => {
    assert.equal((await fetchRunResults({ id: 1 })).failedStep, null);
  });
});
