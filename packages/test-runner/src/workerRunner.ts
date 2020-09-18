/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FixturePool, rerunRegistrations, assignParameters, TestInfo, parameters } from './fixtures';
import { EventEmitter } from 'events';
import { setCurrentTestFile } from './expect';
import { WorkerSpec, WorkerSuite } from './workerTest';
import { Config } from './config';
import * as util from 'util';
import { serializeError } from './util';
import { TestBeginPayload, TestEndPayload, TestRun, TestRunnerEntry } from './ipc';
import { workerSpec } from './workerSpec';

export const fixturePool = new FixturePool();

function chunkToParams(chunk: Buffer | string):  { text?: string, buffer?: string } {
  if (chunk instanceof Buffer)
    return { buffer: chunk.toString('base64') };
  if (typeof chunk !== 'string')
    return { text: util.inspect(chunk) };
  return { text: chunk };
}

export class WorkerRunner extends EventEmitter {
  private _failedTestId: string | undefined;
  private _fatalError: any | undefined;
  private _ids: Set<string>;
  private _remaining: Set<string>;
  private _trialRun: any;
  private _parsedParameters: any = {};
  private _config: Config;
  private _testId: string | null;
  private _stdOutBuffer: (string | Buffer)[] = [];
  private _stdErrBuffer: (string | Buffer)[] = [];
  private _testRun: TestRun | null = null;
  private _suite: WorkerSuite;
  private _loaded = false;
  private _parametersString: string;
  private _workerId: number;

  constructor(entry: TestRunnerEntry, config: Config, workerId: number) {
    super();
    this._suite = new WorkerSuite('');
    this._suite.file = entry.file;
    this._workerId = workerId;
    this._parametersString = entry.parametersString;
    this._ids = new Set(entry.ids);
    this._remaining = new Set(entry.ids);
    this._trialRun = config.trialRun;
    this._config = config;
    for (const {name, value} of entry.parameters)
      this._parsedParameters[name] = value;
    this._parsedParameters['config'] = config;
    this._parsedParameters['parallelIndex'] = workerId;
    setCurrentTestFile(this._suite.file);
  }

  stop() {
    this._trialRun = true;
  }

  unhandledError(error: Error | any) {
    if (this._testRun) {
      this._testRun.status = 'failed';
      this._testRun.error = serializeError(error);
      this._failedTestId = this._testId;
      this.emit('testEnd', {
        id: this._testId,
        testRun: this._testRun
      } as TestEndPayload);
      this._testRun = null;
    } else if (!this._loaded) {
      // No current test - fatal error.
      this._fatalError = serializeError(error);
    }
    this._reportDone();
  }

  stdout(chunk: string | Buffer) {
    this._stdOutBuffer.push(chunk);
    for (const c of this._stdOutBuffer)
      this.emit('testStdOut', { id: this._testId, ...chunkToParams(c) });
    this._stdOutBuffer = [];
  }

  stderr(chunk: string | Buffer) {
    this._stdErrBuffer.push(chunk);
    for (const c of this._stdErrBuffer)
      this.emit('testStdErr', { id: this._testId, ...chunkToParams(c) });
    this._stdErrBuffer = [];
  }

  async run() {
    assignParameters(this._parsedParameters);

    const revertBabelRequire = workerSpec(this._suite, this._config.timeout, parameters);

    // Trial mode runs everything in one worker, delete test from cache.
    delete require.cache[this._suite.file];

    require(this._suite.file);
    revertBabelRequire();
    // Enumerate tests to assign ordinals.
    this._suite._renumber();
    // Build ids from ordinals + parameters strings.
    this._suite._assignIds(this._parametersString);
    this._loaded = true;

    rerunRegistrations(this._suite.file);
    await this._runSuite(this._suite);
    this._reportDone();
  }

  private async _runSuite(suite: WorkerSuite) {
    if (!this._trialRun) {
      try {
        await this._runHooks(suite, 'beforeAll', 'before');
      } catch (e) {
        this._fatalError = serializeError(e);
        this._reportDone();
      }
    }
    for (const entry of suite._entries) {
      if (entry instanceof WorkerSuite)
        await this._runSuite(entry);
      else
        await this._runTest(entry as WorkerSpec);
    }
    if (!this._trialRun) {
      try {
        await this._runHooks(suite, 'afterAll', 'after');
      } catch (e) {
        this._fatalError = serializeError(e);
        this._reportDone();
      }
    }
  }

  private async _runTest(test: WorkerSpec) {
    if (this._failedTestId)
      return false;
    if (this._ids.size && !this._ids.has(test._id))
      return;
    this._remaining.delete(test._id);

    const id = test._id;
    this._testId = id;

    const testRun: TestRun = {
      skipped: test._modifier._isSkipped(),
      flaky: test._modifier._isFlaky(),
      slow: test._modifier._isSlow(),
      annotations: test._modifier._collectAnnotations(),
      expectedStatus: test._modifier._computeExpectedStatus(),
      timeout: test._modifier._computeTimeout(),
      workerId: this._workerId,
    
      duration: 0,
      status: 'passed',
      stdout: [],
      stderr: [],
      data: {}
    };
    this._testRun = testRun;

    const testBeginEvent: TestBeginPayload = { id, testRun };
    this.emit('testBegin', testBeginEvent);

    if (test._modifier._isSkipped()) {
      testRun.status = 'skipped';
      const testEndEvent: TestEndPayload = { id, testRun };
      this.emit('testEnd', testEndEvent);
      return;
    }

    const startTime = Date.now();
    try {
      const testInfo: TestInfo = {
        config: this._config,
        spec: test,
        testRun
      };
      if (!this._trialRun) {
        await this._runHooks(test.parent as WorkerSuite, 'beforeEach', 'before', testInfo);
        await fixturePool.runTestWithFixturesAndTimeout(test.fn, this._testRun.timeout, testInfo);
        await this._runHooks(test.parent as WorkerSuite, 'afterEach', 'after', testInfo);
      } else {
        testRun.status = test._modifier._computeExpectedStatus();
      }
    } catch (error) {
      // Error in the test fixture teardown.
      testRun.status = 'failed';
      testRun.error = serializeError(error);
    }
    testRun.duration = Date.now() - startTime;
    if (this._testRun) {
      // We could have reported end due to an unhandled exception.
      this.emit('testEnd', { id, testRun });
    }
    if (!this._trialRun && testRun.status !== 'passed')
      this._failedTestId = this._testId;
    this._testRun = null;
    this._testId = null;
  }

  private async _runHooks(suite: WorkerSuite, type: string, dir: 'before' | 'after', testInfo?: TestInfo) {
    if (!suite._hasTestsToRun())
      return;
    const all = [];
    for (let s = suite; s; s = s.parent as WorkerSuite) {
      const funcs = s._hooks.filter(e => e.type === type).map(e => e.fn);
      all.push(...funcs.reverse());
    }
    if (dir === 'before')
      all.reverse();
    for (const hook of all)
      await fixturePool.resolveParametersAndRun(hook, this._config, testInfo);
  }

  private _reportDone() {
    this.emit('done', {
      failedTestId: this._failedTestId,
      fatalError: this._fatalError,
      remaining: [...this._remaining],
    });
  }
}