'use strict';

var path = require('path');
var assert = require('chai').assert;
var child_process = require('child_process');
var _ = require('lodash');
var spawnSync = require('spawn-sync'); // node 0.10.x support
var request = require('request');
var Host = require('..');
var Manager = require('../lib/Manager');
var post = require('./utils').post;

var pathToBin = path.join(__dirname, '..', 'bin', 'js-host.js');
var pathToTestConfig = path.join(__dirname, 'test_config', 'config.js');
var pathToEmptyConfig = path.join(__dirname, 'test_config', 'empty.js');

// Node 0.10.x seems to provide few details when reporting errors across processes,
// so we need to assume less helpful behaviour when testing it
var IS_NODE_ZERO_TEN = _.startsWith(process.version, 'v0.10');

describe('bin/js-host.js', function() {
  it('can read in a config and start a properly configured host', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig]
    );

    var host = new Host(
      _.defaults({silent: true}, require('./test_config/config.js'))
    );

    // Wait for stdout, which should indicate the server's running
    process.stdout.once('data', function(data) {
      assert.equal(data.toString(), 'Host listening at 127.0.0.1:8000\n');
      post(host, 'echo', {data: {echo: 'echo-test'}}, function(err, res, body) {
        assert.isNull(err);
        assert.equal(body, 'echo-test');
        post(host, 'echo_async', function(err, res, body) {
          assert.equal(res.statusCode, 500);
          assert.include(body, '`echo` data not provided');
          post(host, 'echo_async', {data: {echo: 'echo_async-test'}}, function(err, res, body) {
            assert.isNull(err);
            assert.equal(body, 'echo_async-test');
            post(host, 'echo_async', function(err, res, body) {
              assert.isNull(err);
              assert.equal(res.statusCode, 500);
              assert.include(body, '`echo` data not provided');
              process.kill();
              done();
            });
          });
        });
      });
    });

    var stderr = '';

    process.stderr.on('data', function(data) {
      stderr += data.toString();
    });

    process.on('exit', function(data) {
      if (stderr) {
        throw new Error(stderr);
      }
    });
  });
  it('an error thrown in a function will not take down the process', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig]
    );

    var host = new Host(
      _.defaults({silent: true}, require('./test_config/config.js'))
    );

    var stderr = '';

    process.stderr.on('data', function(data) {
      stderr += data.toString();
    });

    // Wait for stdout, which should indicate the server's running
    process.stdout.once('data', function(data) {
      assert.equal(data.toString(), 'Host listening at 127.0.0.1:8000\n');
      post(host, 'error', function(err, res, body) {
        assert.equal(res.statusCode, 500);
        assert.include(body, 'Error: Error function');
        post(host, 'echo', {data: {echo: 'echo-test'}}, function(err, res, body) {
          assert.equal(body, 'echo-test');
          process.kill();
          assert.include(stderr, 'Error: Error function');
          done();
        });
      });
    });
  });
  it('can output the complete config of a host', function() {
    var output = spawnSync(
      'node', [pathToBin, pathToTestConfig, '--config']
    );

    var config = JSON.parse(output.stdout.toString());

    assert.isObject(config);

    assert.equal(config.address, '127.0.0.1');
    assert.equal(config.port, 8000);
    assert.isArray(config.functions);
    assert.equal(config.functions.length, 3);
    assert.isTrue(config.silent);
  });
  it('can start listening and output the config as JSON', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig, '--json']
    );

    process.stdout.once('data', function(data) {
      var config = JSON.parse(data.toString());
      assert.equal(config.address, '127.0.0.1');
      assert.equal(config.port, 8000);
      assert.isArray(config.functions);
      assert.equal(config.functions.length, 3);
      assert.isTrue(config.silent);
      process.kill();
      done();
    });
  });
  it('can override the config\'s port when starting a host', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig, '--port', '8080', '--json']
    );

    var testConfig = require(pathToTestConfig);

    assert.equal(testConfig.port, 8000);

    process.stdout.once('data', function(data) {
      var config = JSON.parse(data.toString());
      assert.equal(config.address, '127.0.0.1');
      assert.equal(config.port, '8080');
      assert.notEqual(
        // Ensure both ports are coerced to the same type
        '' + config.port,
        '' + testConfig.port
      );
      assert.isArray(config.functions);
      assert.equal(config.functions.length, 3);
      assert.isTrue(config.silent);
      var host = new Host({
        silent: true,
        port: config.port
      });
      assert.equal(host.getUrl(), 'http://127.0.0.1:8080');
      post(host, 'echo', {data: {echo: 'foo'}}, function(err, res, body) {
        assert.isNull(err);
        assert.equal(body, 'foo');
        process.kill();
        done();
      });
    });
  });
  it('can start a manager process which can start/host/stop hosts', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig, '--manager', '--json']
    );

    process.stdout.once('data', function(data) {
      var output = data.toString();
      var config = JSON.parse(output);
      config.functions = null;
      var manager = new Manager(config);
      request.post(manager.getUrl() + '/host/start?config=' + encodeURIComponent(pathToTestConfig), function(err, res, body) {
        assert.isNull(err);
        assert.notEqual(body, output);
        var hostJson = JSON.parse(body);
        assert.isTrue(hostJson.started);
        var hostConfig = JSON.parse(hostJson.output);
        assert.equal(hostConfig.address, '127.0.0.1');
        assert.isNumber(hostConfig.port);
        var host = new Host(_.omit(hostConfig, 'functions'));
        post(host, 'echo', {data: {echo: 'test'}}, function(err, res, body) {
          assert.isNull(err);
          assert.equal(body, 'test');
          request.post(manager.getUrl() + '/host/stop?config=' + encodeURIComponent(pathToTestConfig), function(err, res, body) {
            assert.isNull(err);
            assert.deepEqual(JSON.parse(body), hostConfig);
            setTimeout(function() {
              post(host, 'echo', {data: {echo: 'test'}}, function(err, res, body) {
                assert.instanceOf(err, Error);
                process.kill();
                done();
              });
            }, 50);
          });
        });
      });
    });
  });
  it('can have a manager process automatically exit once it\'s last host has stopped', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig, '--manager', '--json']
    );

    var hasExited = false;
    process.once('exit', function() {
      hasExited = true;
    });

    process.stdout.once('data', function(data) {
      var output = data.toString();
      var config = JSON.parse(output);
      config.functions = null;
      var manager = new Manager(config);
      request.post(manager.getUrl() + '/host/start?config=' + encodeURIComponent(pathToTestConfig), function(err, res, body) {
        assert.isNull(err);
        assert.notEqual(body, output);
        var hostJson = JSON.parse(body);
        assert.isTrue(hostJson.started);
        var hostConfig = JSON.parse(hostJson.output);
        assert.equal(hostConfig.address, '127.0.0.1');
        assert.isNumber(hostConfig.port);
        var host = new Host(_.omit(hostConfig, 'functions'));
        post(host, 'echo', {data: {echo: 'test'}}, function(err, res, body) {
          assert.isNull(err);
          assert.equal(body, 'test');
          request.post(manager.getUrl() + '/host/stop?stop-manager-if-last-host&config=' + encodeURIComponent(pathToTestConfig), function(err, res, body) {
            assert.isNull(err);
            assert.deepEqual(JSON.parse(body), hostConfig);
            setTimeout(function() {
              post(host, 'echo', {data: {echo: 'test'}}, function(err, res, body) {
                assert.instanceOf(err, Error);
                request.post(manager.getUrl() + '/status', function(err, res, body) {
                  assert.instanceOf(err, Error);
                  assert.isTrue(hasExited);
                  done();
                });
              });
            }, 50);
          });
        });
      });
    });
  });
  it('can stop a manager process at the /manager/stop endpoint', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToTestConfig, '--manager', '--json']
    );

    var hasExited = false;
    process.once('exit', function() {
      hasExited = true;
    });

    process.stdout.once('data', function(data) {
      var output = data.toString();
      var config = JSON.parse(output);
      config.functions = null;
      var manager = new Manager(config);
      request.post(manager.getUrl() + '/manager/stop', function(err, res, body) {
        assert.isNull(err);
        assert.equal(body, 'Stopping...');
        setTimeout(function() {
          assert.isTrue(hasExited);
          done();
        }, 20);
      });
    });
  });
  it('throws an error if a config file does not exist', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, '/missing/file.js']
    );

    process.stderr.once('data', function(data) {
      var output = data.toString();
      if (!IS_NODE_ZERO_TEN) {
        assert.include(output, '/missing/file.js');
      }
      process.kill();
      done();
    });
  });
  it('throws an error if a config file does not export an object', function(done) {
    var process = child_process.spawn(
      'node', [pathToBin, pathToEmptyConfig]
    );

    process.stderr.once('data', function(data) {
      var output = data.toString();
      if (!IS_NODE_ZERO_TEN) {
        assert.include(output, 'Config file does not export an object');
        assert.include(output, pathToEmptyConfig);
      }
      process.kill();
      done();
    });
  });
});