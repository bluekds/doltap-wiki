import { describe, expect, it } from "vitest";
import { WikiDb } from "../src/index.js";

/** 0.12 search ranking: question words are not terms; `set` and `new` are (see golden.json for the ranking cases). */
describe("query tokens", () => {
  it("drop question and auxiliary words but keep set and new", () => {
    expect(WikiDb.queryTokens("where does the wiki run launchd services")).toEqual(["wiki", "run", "launchd", "services"]);
    expect(WikiDb.queryTokens("set up the wiki on a new machine")).toEqual(["set", "wiki", "new", "machine"]);
    expect(WikiDb.queryTokens("call the gb10 ai server from another machine")).toEqual(["call", "gb10", "ai", "server", "machine"]);
    // A query of nothing but stopwords still searches for something.
    expect(WikiDb.queryTokens("where is it")).toEqual(["where", "is", "it"]);
  });
});
