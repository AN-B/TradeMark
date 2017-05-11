"use strict";

process.env.EXPORT_EXPRESS_APP = true;
process.env.NO_CLUSTER = process.env.NO_CLUSTER || true;
process.env.BUILD_ENV = process.env.BUILD_ENV || 'test';
process.env.LOCAL_DEBUG = process.env.LOCAL_DEBUG || true;
process.env.LOG_LINE_NUMS = process.env.LOG_LINE_NUMS || true;
process.env.SKIP_CLIENT_AUTH = process.env.SKIP_CLIENT_AUTH || 'Yes';

var ConnectionCache = require('./hgnode/framework/ConnectionCache'),
    HgLog = require('./hgnode/framework/HgLog'),
    ChildProcess = require('child_process'),
    async = require('async'),
    worker,
    memcached,
    mongod,
    redish,
    requireUncached = function (module) {
        delete require.cache[require.resolve(module)];
        return require(module);
    },
    launchApps = function (callback) {
        var servers = [
                {
                    serverType: 'web',
                    port: 8095,
                    testPort: 8895
                }, {
                    serverType: 'api',
                    port: 8096,
                    testPort: 8896
                }, {
                    serverType: 'esb',
                    port: 8097,
                    testPort: 8897
                }, {
                    serverType: 'mobile',
                    port: 8098,
                    testPort: 8898
                }
            ];

        async.each(servers, function (server, callback) {
            process.env.SERVER_TYPE = server.serverType;
            server.app = requireUncached('./server');
            server.app.listen(process.env.BUILD_ENV === 'test' ? server.testPort : server.port);

            HgLog.verbose('🚀  Launched ' + server.serverType + ' server - ' + 'http://localhost:' + server.port);
            callback();
        }, function (err) {
            if (err) {
                HgLog.error('🚀💥  Error launching apps:', error);
            }
            if (callback) {
                callback();
            }
        });
    },
    shouldLoadFixtures = function () {
        var ret = false;
        process.argv.forEach(function (val) {
            if (val === '--fixtures' || val === '-f') {
                ret = true;
            }
        });
        return ret;
    },
    loadFixturesIfNecessary = function (callback) {
        var config = require('./hgnode/configurations/config'),
            fixtureLoader = require('./hgnode/test/testHelpers/fixtureLoader'),
            path = require('path'),
            fixtureDirPath = path.normalize(__dirname + '/hgnode/test/fixtures');

        if (shouldLoadFixtures()) {
            if (config.mongodb.hgcommon.indexOf('_test') > -1) {
                fixtureLoader.load(fixtureDirPath, function (err, data) {
                    if (err) {
                        HgLog.error('🚀💥  Error loading fixtures:', err);
                        return callback(err);
                    }
                    HgLog.verbose(data.fixturesLoaded + " fixtures loaded");
                    callback();
                })
            } else {
                HgLog.error('Did not load fixtures, config did not switch to _test db.');
                HgLog.error('Is BUILD_ENV set to test?');
                process.exit(-1);
            }
        } else {
            callback();
        }
    },
    launchMongoIfNecessary = function (callback) {
        ChildProcess.exec('pgrep mongod', function (error) {
            if (error && error.code === 1) {
                //no processes were matched
                mongod = ChildProcess.exec('mongod', function (error) {
                    if (error) {
                        HgLog.debug('🚀💥  Error with mongod:', error);
                        return callback(error);
                    }
                });

                //give mongod a bit of time to complete its startup
                setTimeout(function () {
                    HgLog.verbose('🚀  Launched mongod');
                    callback();
                }, 1500);
            } else {
                callback();
            }
        });
    },
    launchRedis = function (callback) {
        redish = ChildProcess.exec('redis-server', function (error) {
            if (error) {
                HgLog.error('🚀💥  Error with redish:', error);
            }
        });

        HgLog.verbose('🚀  Launched stupid redish');
        callback();
    },
    launchMemcached = function (callback) {
        memcached = ChildProcess.exec('memcached', function (error) {
            if (error) {
                HgLog.error('🚀💥  Error with memcached:', error);
                return callback(error);
            }
        });
        HgLog.verbose('🚀  Launched memcached');
        callback();
    },
    launchWorker = function (callback) {
        worker = ChildProcess.fork('./worker');
        HgLog.verbose('🚀  Launched worker');
        callback();
    },
    initConnectionCache = function (callback) {
        ConnectionCache.init(function () {
            callback();
        });
    };


if (require.main === module) {
    // this file is being executed from the command line, launch the apps
    async.waterfall([
        launchMongoIfNecessary,
        launchMemcached,
        launchRedis,
        initConnectionCache,
        loadFixturesIfNecessary,
        launchApps,
        launchWorker
    ]);

    process.on('exit', function () {
        if (worker && worker.pid) {
            HgLog.verbose('shutting down worker before exiting');
            process.kill(worker.pid);
        }

        if (!memcached.exitCode) {
            HgLog.verbose('shutting down memcached before exiting');
            process.kill(memcached.pid);
        }
        if (redish && !redish.exitCode) {
            HgLog.verbose('shutting down stupid redish before exiting');
        }
        if (mongod && !mongod.exitCode) {
            HgLog.verbose('shutting down mongod before exiting');
            process.kill(mongod.pid);
        }
    });
} else {
    // this file is being required() as a module, return the launchApps function
    module.exports = {
        launchApps: launchApps
    };
}