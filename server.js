/*jslint node:true es5:true nomen:true*/
'use strict';

var maxWorkers = process.env.MAX_WORKERS || 1,
    cluster = require('cluster'),
    numCPUs = require('os').cpus().length,
    workers = numCPUs >= maxWorkers ? maxWorkers : numCPUs,
    Logger = require('./hgnode/framework/HgLog.js'),
    http = require('http'),
    https = require('https'),
    ClusterMessageEnums = require('./hgnode/enums/ClusterMessageEnums.js'),
    updatedTimestamp = Date.now(),
    terminologyTimestamp = Date.now(),
    exceptionNotifyer = require('./hgnode/framework/ExceptionNotifier.js'),
    HgCache,
    TokenHelper = require('./hgnode/helpers/tokenHelper.js'),
    index = 0,
    serverDomain,
    httpServer;

// DO NOT REMOVE -- needed for new relic monitoring
if (process.env.NEW_RELIC_LICENSE_KEY) {
    require('newrelic');
}

/**
 * RedisConnectionCache bootstraps itself on being required, it needs to be required below the require for New Relic so
 * that New Relic can hook into redis when it is initialized and bootstrapped.
 */
HgCache = require('./hgnode/framework/RedisConnectionCache');

// set the build version in the process.env.BUILD_VERSION variable
process.env.BUILD_VERSION = '314159265359';

require('./hgnode/framework/RequireExt.js');
require('./hgnode/util/StringMethods.js');

// handle messaging to other cluster workers
function clusterMessageHandler(msg) {
    if (msg.cmd) {
        Object.keys(cluster.workers).forEach(function (id) {
            if (cluster.workers[id].send) {
                cluster.workers[id].send({
                    cmd: msg.cmd,
                    payload: msg.payload,
                    pid: msg.pid
                });
            }
        });
    }
}

// read cache for group preferences and custom terminology
function readClusterCacheFromMemCache() {
    HgCache.GlobalGet(ClusterMessageEnums.UpdateCacheTimestamp, function (err, result) {
        var ts;
        if (!err && result) {
            ts = JSON.parse(result);
            if (ts[ClusterMessageEnums.GroupPreferencesTimestamp] > updatedTimestamp) {
                updatedTimestamp = ts[ClusterMessageEnums.GroupPreferencesTimestamp];
                HgCache.GlobalGet(ClusterMessageEnums.UpdateClusterCache, function (err, result) {
                    if (!err && result) {
                        clusterMessageHandler({
                            cmd: ClusterMessageEnums.UpdateClusterCache,
                            payload: JSON.parse(result)
                        });
                    }
                });
            }
        }
    });
    HgCache.GlobalGet(ClusterMessageEnums.CustomTerminologyTimestamp, function (err, result) {
        if (!err && result) {
            result = JSON.parse(result);
            if (result.timestamp > terminologyTimestamp) {
                terminologyTimestamp = result.timestamp;
                clusterMessageHandler({
                    cmd: result.cmd,
                    payload: result.GroupId
                });
            }
        }
    });
}

function initClusterWorker(worker) {
    worker.on('message', clusterMessageHandler);
}

if (cluster.isMaster && !process.env.LOCAL_DEBUG && !process.env.NO_CLUSTER) {
    Logger.debug('HighGround ' + (process.env.SERVER_TYPE || 'web') + ' server initializing with a maximum of ' + maxWorkers + ' workers. Master PID: ' + process.pid);
    Logger.debug(numCPUs + ' CPUs detected. Clustering up to ' + workers + ' instances.');

    cluster.on('exit', function (worker, code, signal) {
        if (code !== 130) {
            Logger.warn('Cluster worker ' + worker.process.pid + ' died. code: \'' + code + '\' signal: \'' + (signal || 'N/A') + '\' restarting.');
            initClusterWorker(cluster.fork());
        } else {
            Logger.debug('Cluster worker ' + worker.process.pid + ' died. code: ' + code + ' signal: ' + (signal || 'N/A') + ' not restarting due to shutdown.');
        }
    });

    cluster.on('listening', function (worker, address) {
        Logger.debug('Cluster worker ' + worker.process.pid + ' is now connected to ' + (address.address || 'localhost') + ':' + address.port);
    });

    process.on('SIGINT', function () {
        Logger.debug('SIGINT received, waiting for connections to finish so process can exit gracefully.');
        cluster.disconnect(function () {
            Logger.debug('Cluster has gracefully shutdown.');
            if (!process.env.BUILD_ENV || process.env.BUILD_ENV === 'local') {
                process.exit();
            }
        });
    });

    for (index = 0; index < workers; index += 1) {
        initClusterWorker(cluster.fork());
    }

    // set the interval to 5 minutes (5 * 60 * 1000)
    setInterval(readClusterCacheFromMemCache, process.env.CACHE_REFRESH || 300000);
} else {
    serverDomain = require('domain').create();
    serverDomain.on('error', function (err) {
        var pl = serverDomain.errorPayload,
            killtimer;
        try {
            killtimer = setTimeout(function () {
                process.exit(1);
            }, 5000);
            killtimer.unref();
            httpServer.close();

            if (cluster.worker) {
                cluster.worker.disconnect();
            }
            if (pl.req.body.Password) {
                pl.req.body.Password = '';
            }
            exceptionNotifyer({Exception: err, UserToken: pl.userToken, Payload: pl.req.body || pl.req.query, ServerType: pl.serverType});
            Logger.info('Unhandled Exception in domain of cluster worker ' + process.pid);
            Logger.info(err.stack || err);
            if (pl.res) {
                pl.res.statusCode = 500;
                if (!pl.res._headerSent) {
                    pl.res.setHeader('content-type', 'text/plain');
                }
                if (!pl.res.finished) {
                    pl.res.end('http.error.sre');
                }
            }
        } catch (er2) {
            exceptionNotifyer({Exception: er2, UserToken: pl.userToken, Payload: pl.req.body || pl.req.query, ServerType: pl.serverType}, function (notifierError, notifierResponse) {
                Logger.info('Error cleaning up after error in cluster worker ' + process.pid + ' domain: ');
                Logger.info(er2.stack || er2);
                Logger.info(notifierError);
                Logger.info(notifierResponse);
                process.exit(1);
            });
        }
    });

    serverDomain.run(function () {
        var config = require('./hgnode/configurations/config.js'),
            async = require('async'),
            keystore = require('./hgnode/configurations/keystore.js'),
            express = require('express'),
            bodyParser = require('body-parser'),
            compress = require('compression'),
            ServiceHandler = require('./hgnode/framework/ServiceHandler.js'),
            ClusterCache = require('./hgnode/framework/ClusterCache.js'),
            i18nHelper = require('./hgnode/helpers/i18nHelper.js'),
            cryptoHelper = require('./hgnode/helpers/cryptoHelper.js'),
            port = process.env.PORT || 8095,
            environment = process.env.BUILD_ENV || 'local',
            serverType = process.env.SERVER_TYPE || 'web',
            serverFactory = {},
            tokenHelperMap = {
                web: TokenHelper.GetToken,
                mobile: TokenHelper.GetMobileToken,
                esb: function () { return; },
                api: function () { return; }
            },
            maxConnections = 100000,
            corsUrl = [config.protocol, '//', config.baseUrl.replace(/\//g, '')].join(''),
            bodyParserUrl = bodyParser.urlencoded({
                extended: true,
                keepExtensions: true,
                limit: '5mb'
            }),
            enableCORS = environment !== 'test' && environment !== 'local',
            ConnectionCache = require('./hgnode/framework/ConnectionCache.js'),
            allowXFrameRegExp = new RegExp("(.salesforce.com|.staticforce.com|.force.com)", "gi"),
            allowCrossDomain = function (req, res, next) {
                if (process.env.LOCAL_DOMAIN) {
                    res.header('Access-Control-Allow-Origin', process.env.LOCAL_DOMAIN);
                } else {
                    res.header('Access-Control-Allow-Origin', corsUrl);
                }
                res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
                res.header('Access-Control-Allow-Headers', 'Content-Type, f, tzo');
                res.header('Access-Control-Allow-Credentials', 'true');
                res.header('Access-Control-Expose-Headers', 'error');
                // cache the preflight for a week
                res.header('Access-Control-Max-Age', 10080);
                next();
            },
            setupDomainErrorListener = function (req, res, next, serverType) {
                var token = tokenHelperMap[serverType](req, 'UserToken');
                serverDomain.errorPayload = {
                    req: req,
                    res: res,
                    serverType: serverType,
                    userToken: token ? cryptoHelper.encrypt(token).toString('base64') : 'N/A'
                };
                next();
            },
            setupDomainErrorListenerWeb = function (req, res, next) {
                setupDomainErrorListener(req, res, next, 'web');
            },
            setupDomainErrorListenerEsb = function (req, res, next) {
                setupDomainErrorListener(req, res, next, 'esb');
            },
            setupDomainErrorListenerApi = function (req, res, next) {
                setupDomainErrorListener(req, res, next, 'api');
            },
            setupDomainErrorListenerMobile = function (req, res, next) {
                setupDomainErrorListener(req, res, next, 'mobile');
            },
            EntityCache,
            app = express();

        require('http').globalAgent.maxSockets = maxConnections;
        require('https').globalAgent.maxSockets = maxConnections;

        function useSSl(req, res, next) {
            if ((req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') {
                next();
            } else {
                res.redirect(301, 'https://' + req.headers.host + req.url);
            }
        }

        function useStrictTransportSecurity(req, res, next) {
            res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
            next();
        }

        function xframeOptions(req, res, next) {
            res.header('X-Powered-By', '1001000.1000111');
            if (!(req.headers.referer || req.headers.host || 'localhost').match(allowXFrameRegExp)) {
                res.header('X-Frame-Options', 'SAMEORIGIN');
                res.header('Content-Security-Policy', "frame-ancestors 'self'");
            }
            next();
        }

        function nocache(req, res, next) {
            res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
            res.header('Expires', '-1');
            res.header('Pragma', 'no-cache');
            next();
        }

        function parallel(middlewares) {
            return function (req, res, next) {
                async.each(middlewares, function (mw, cb) {
                    mw(req, res, cb);
                }, next);
            };
        }

        // handle the message being sent from the master process
        process.on('message', function (msg) {
            if (msg && msg.cmd && msg.cmd && msg.pid !== process.pid) {
                switch (msg.cmd) {
                case ClusterMessageEnums.UpdateClusterCache:
                    ClusterCache.set(msg.payload);
                    break;
                case ClusterMessageEnums.UpdateCustomTerminology:
                    i18nHelper.setAllCustomTerminologyFiles({
                        EntityCache: EntityCache,
                        query: { GroupId: msg.payload }
                    });
                    break;
                case ClusterMessageEnums.RemoveCustomTerminology:
                    i18nHelper.removeCustomTerminology(msg.payload);
                    break;
                }
            }
        });

        serverFactory.web = function () {
            var cookieParser = require('cookie-parser'),
                multer = require('multer'),
                svgUtil = require('./hgnode/helpers/svgUtil.js'),
                fileUpload = require('./hgnode/helpers/fileUpload.js'),
                staticAsset = require('static-asset'),
                buildVersion = JSON.stringify({
                    buildVersion: '314159265359'
                }),
                middleWares = [
                    xframeOptions,
                    compress(),
                    cookieParser(),
                    bodyParser.json({
                        limit: '5mb'
                    }),
                    setupDomainErrorListenerWeb,
                    bodyParserUrl,
                    multer({dest: './static/img/tmp'})
                ];

            if (config.protocol === 'https:') {
                middleWares.unshift(useSSl);
                middleWares.unshift(useStrictTransportSecurity);
            }

            if (enableCORS) {
                middleWares.unshift(allowCrossDomain);
            }

            // run all of the middle ware packages in parallel
            app.use(parallel(middleWares));

            if (environment === 'local') {
                app.use('/test', express.static(__dirname + '/test'));
                app.use('/www', express.static(__dirname + '/www'));
                app.get('/templates/i18n/custom-map.json', function (req, res) {
                    res.sendFile(__dirname + '/static/lang/custom-map.json');
                });
            }
            if (['prod', 'demo', 'st'].indexOf(environment) === -1) {
                app.use('/styleguide', express.static(__dirname + '/styleguide'));
            }

            app.post('/svc/:ServiceName/:MethodName', bodyParserUrl, ServiceHandler.ProcessRequest);    // Post to a service method
            app.get('/svc/:ServiceName/:MethodName', ServiceHandler.ProcessRequest);     // Get to a service method
            app.get('/svc/:ServiceName/:MethodName/:Id', ServiceHandler.ProcessRequest); // Get to a service method with a an id for shortcut

            app.get('/', function (req, res) {
                if (req.headers['user-agent'].indexOf("MSIE") >= 0) {
                    if (parseInt(req.headers['user-agent'].split('MSIE')[1], 10) < 9) {
                        Logger.debug('sending error.html');
                        return res.sendFile(__dirname + '/static/unsupported.html');
                    }
                }
                if (TokenHelper.GetToken(req, 'UserToken')) {
                    res.sendFile(__dirname + '/static/index.html');
                } else {
                    Logger.debug('sending login.html');
                    res.sendFile(__dirname + '/static/login.html');
                }
            });

            app.get('/redirect', function (req, res) {
                var destination = req.query.destination || '';
                res.redirect('/' + destination);
            });

            app.get('/login', function (req, res) {
                res.redirect('/');
            });

            app.get('/login/:company', function (req, res) {
                if (TokenHelper.GetToken(req, 'UserToken')) {
                    res.redirect('/');
                } else {
                    res.redirect('/#/login/' + req.params.company);
                }
            });

            app.get('/public', function (req, res) {
                res.sendFile(__dirname + '/static/public.html');
            });

            app.get('/provision', function (req, res) {
                res.sendFile(__dirname + '/static/provision.html');
            });

            app.get('/survey', function (req, res) {
                res.sendFile(__dirname + '/static/survey.html');
            });

            app.get('/display', function (req, res) {
                res.sendFile(__dirname + '/static/display.html');
            });

            app.get('/environment', function (req, res) {
                res.send(JSON.stringify({
                    pusherKey: keystore.pusher.key,
                    imageStore: config.s3store.imageStore,
                    baseUrl: config.baseUrl,
                    javascriptDirectory: config.s3store.javascriptDirectory,
                    wwwSite: config.wwwSite,
                    environment: environment,
                    ioUrl: config.ioUrl,
                    i18n: i18nHelper.getLanguageIndex(req.headers['accept-language']),
                    zopimId: keystore.zopim.chat_id
                }), {'Content-Type': 'text/plain'}, 200);
            });

            app.get('/multipassSSO', function (req, res) {
                // if user is logged in, redirect them to auth service
                if (TokenHelper.GetToken(req, 'UserToken')) {
                    res.redirect('/svc/SSO/LoginToMultipass');
                } else {
                    //this is the public support portal
                    res.redirect('https://highground.desk.com');
                }
            });

            // this returns a pulse object for heartbeat
            app.get('/pulse', nocache, function (req, res) {
                res.send(buildVersion, {'Content-Type': 'text/plain'}, 200);
            });

            // mobile: association file for iOS universal links
            app.get('/apple-app-site-association', function (req, res) {
                res.set('Content-Type', 'application/pkcs7-mime');
                res.sendFile(__dirname + '/static/apple-app-site-association');
            });

            app.get('/.well-known/assetlinks.json', function (req, res) {
                res.set('Content-Type', 'application/json');
                res.sendFile(__dirname + '/static/assetlinks.json');
            });

            app.get('/svgx/badges/:origin/:fileName', function (req, response) {
                svgUtil.processSVGBadge({
                    url: config.s3store.imageStore[0] + '/badges/' + req.params.origin + '/' + req.params.fileName,
                    response: response
                });
            });

            app.get('/svgx/badges/group/:origin/:fileName', function (req, response) {
                svgUtil.processSVGBadge({
                    url: config.s3store.imageStore[0] + '/badges/group/' + req.params.origin + '/' + req.params.fileName,
                    response: response
                });
            });

            app.get('/static/svgx*', function (req, response) {
                svgUtil.processSVGBadge({
                    url: '/missing.svg',
                    response: response
                });
            });

            //Transparent Proxy to pull static html files from S3
            app.get('/proxy/template/banner/:companyGUID', function (req, res) {
                var s3Path = config.protocol + config.s3store.htmlTemplateDirectory + '/banner/' + req.params.companyGUID + '.html',
                    protocol = config.protocol === 'https:' ? https : http;
                protocol.get(s3Path, function (proxyRes) {
                    if (proxyRes.statusCode === 200) {
                        proxyRes.pipe(res);
                    } else {
                        Logger.error('Proxy Error: ' + proxyRes.statusCode + ' received for ' + s3Path);
                        res.end();
                    }

                });
            });

            app.get('/proxy/badges/original/:fileName', function (req, res) {
                svgUtil.getSvgFile({
                    res: res,
                    url: config.s3store.imageStore[0] + '/badges/original/' + req.params.fileName
                });
            });

            app.get('/proxy/badges/group/:groupNumber/:fileName', function (req, res) {
                svgUtil.getSvgFile({
                    res: res,
                    url: config.s3store.imageStore[0] + '/badges/group/' + req.params.groupNumber + '/' + req.params.fileName
                });
            });

            //Transparent Proxy to pull
            app.get('/proxy/email/:viewId', function (req, res) {
                var viewURL = 'http://viewer.expresspigeon.com/view_online?v=' + req.params.viewId;
                http.get(viewURL, function (proxyRes) {
                    if (proxyRes.statusCode === 200) {
                        proxyRes.pipe(res);
                    } else {
                        Logger.error('Proxy Error: ' + proxyRes.statusCode + ' received for ' + viewURL);
                        res.end();
                    }
                });
            });

            app.post('/SetUserProfileAvatar', function (req, res) {
                fileUpload.imgProcess(req.body, __dirname, function (err, data) {
                    if (err) {
                        res.send('Server Error: ' + err, {'Content-Type': 'text/plain'}, 503);
                    } else {
                        res.send(data, 200);
                    }
                });
            });

            app.get('/templates/i18n/:langFile', nocache, function (req, res) {
                if (req && req.params && req.params.langFile === 'custom-map.json') {
                    return res.sendFile(__dirname + '/static/templates/i18n/custom-map.json');
                }
                if (EntityCache) {
                    i18nHelper.getLanguageFile({req: req, EntityCache: EntityCache}, function (err, lang) {
                        if (err) {
                            res.send('Server Error: ' + err, {'Content-Type': 'text/plain'}, 503);
                        } else {
                            res.send(lang, {'Content-Type': 'application/json'}, 200);
                        }
                    });
                } else {
                    res.send(i18nHelper.getEnglishFile(), {'Content-Type': 'application/json'}, 200);
                }
            });

            app.use(staticAsset(__dirname + '/static'));
            app.use('/provision/templates', express.static(__dirname + '/static/templates'));
            app.use('/public/templates', express.static(__dirname + '/static/templates'));
            app.use('/', express.static(__dirname + '/static'));
            app.use('/static', express.static(__dirname + '/static'));
            app.use('/provision/static', express.static(__dirname + '/static'));
            app.use('/public/static', express.static(__dirname + '/static'));

            ClusterCache.init(EntityCache);
        };

        serverFactory.esb = function () {
            app.use(compress());
            app.use(bodyParser.json({
                limit: '5mb'
            }));
            app.use(setupDomainErrorListenerEsb);
            app.use(bodyParserUrl);
            if (config.protocol === 'https:') {
                app.use(useSSl);
            }

            if (environment === 'local') {
                app.use('/', express.static(__dirname + '/static'));
            }
            app.post('/esb/:ServiceName/:MethodName', ServiceHandler.ProcessRequest);    // Post to a service method
            app.get('/esb/:ServiceName/:MethodName', ServiceHandler.ProcessRequest);     // Get to a service method
            ClusterCache.init(EntityCache);
        };

        serverFactory.mobile = function () {
            var multer = require('multer'),
                middleWares = [
                    compress(),
                    bodyParser.json({
                        limit: '5mb'
                    }),
                    setupDomainErrorListenerMobile,
                    bodyParserUrl,
                    multer({dest: './static/img/tmp'})
                ];

            if (config.protocol === 'https:') {
                middleWares.unshift(useSSl);
            }

            if (enableCORS) {
                middleWares.unshift(allowCrossDomain);
            }

            // run all of the middle ware packages in parallel
            app.use(parallel(middleWares));

            // Handle ping from certificate pinning requests
            app.get('/', function (req, res) {
                res.sendStatus(200);
            });

            app.get('/environment', function (req, res) {
                res.send({
                    latestVersion: "1.12.4.7064"
                }, {'Content-Type': 'application/json'}, 200);
            });

            app.get('/templates/i18n/:langFile', nocache, function (req, res) {
                if (EntityCache) {
                    i18nHelper.getMobileLanguageFile({req: req, EntityCache: EntityCache}, function (err, lang) {
                        if (err) {
                            res.send('Server Error: ' + err, {'Content-Type': 'text/plain'}, 503);
                        } else {
                            res.send(lang, {'Content-Type': 'application/json'}, 200);
                        }
                    });
                } else {
                    res.send({}, {'Content-Type': 'application/json'}, 200);
                }
            });

            if (environment === 'local') {
                app.use('/', express.static(__dirname + '/static'));
            }

            app.post('/:Version/:ServiceName/:MethodName', ServiceHandler.ProcessMobileRequest);    // Post to a service method
            app.get('/:Version/:ServiceName/:MethodName', ServiceHandler.ProcessMobileRequest);     // Get to a service method
            app.get('/:Version/:ServiceName/:MethodName/:Id', ServiceHandler.ProcessMobileRequest); // Get to a service method with a an id for shortcut
        };

        serverFactory.api = function () {
            var APIAuthHandlers = require('./hgnode/security/APIAuthHandlers.js'),
                authMiddleware = APIAuthHandlers.GetHandlers(),
                APIServiceHandler = require('./hgnode/framework/APIHandler.js'),
                service = require('./webSocket.server.js'),
                methodOverride = require('method-override');
            require('express-ws')(app);
            app.ws('/cache', function (ws, req) {
                service.listen(ws, req);
            });
            app.use(compress());
            app.use(bodyParser.json({
                limit: '5mb'
            }));
            app.use(setupDomainErrorListenerApi);
            app.use(bodyParserUrl);
            app.use(methodOverride());
            if (config.protocol === 'https:') {
                app.use(useSSl);
            }

            //this serves up the apidoc folder
            app.use('/', express.static(__dirname + '/apidoc'));

            app.get('/:version/:service', authMiddleware, APIServiceHandler.ProcessRESTGet);
            app.get('/:version/:service/:id', authMiddleware, APIServiceHandler.ProcessRESTGetId);
            app.put('/:version/:service', authMiddleware, APIServiceHandler.ProcessRESTPut);
            app.put('/:version/:service/:id', authMiddleware, APIServiceHandler.ProcessRESTPutId);
            app.delete('/:version/:service', authMiddleware, APIServiceHandler.ProcessRESTDelete);
            app.delete('/:version/:service/:id', authMiddleware, APIServiceHandler.ProcessRESTDeleteId);
            app.post('/:version/:service', authMiddleware, APIServiceHandler.ProcessRESTPost);
            app.post('/:version/:service/create/:eventType', authMiddleware, APIServiceHandler.ProcessRESTPost);
            //operations based API
            app.post('/:version/:service/:action', authMiddleware, APIServiceHandler.ProcessOperationalRequestPost);
            app.post('/:version/:service/:action/:id', authMiddleware, APIServiceHandler.ProcessOperationalRequestPostId);
        };

        function gracefulShutDown() {
            Logger.debug('Application is shutting down for process: ' + process.pid);
            if (httpServer && httpServer.close) {
                httpServer._connections = 0;
                httpServer.close();
            }
            Logger.debug('Closing all database connections for process: ' + process.pid);
            if (ConnectionCache) {
                ConnectionCache.shutdown();
            }
            HgCache.quit();
            if (!process.env.BUILD_ENV || ['local', 'test'].indexOf(process.env.BUILD_ENV) > -1 || process.env.LOCAL_DEBUG) {
                process.exit();
            }
        }

        // on sigterm close the app
        process.on('SIGTERM', gracefulShutDown);
        process.on('SIGINT', gracefulShutDown);

        if (serverFactory[serverType]) {
            if (process.env.EXPORT_EXPRESS_APP) {
                serverFactory[serverType]();
                module.exports = app;
            } else {
                Logger.verbose('Waiting for database connections to warm up...');
                ConnectionCache.init(function () {
                    EntityCache = require('./hgnode/framework/EntityCache.js');
                    i18nHelper.setAllCustomTerminologyFiles({EntityCache: EntityCache});
                    serverFactory[serverType]();
                    httpServer = app.listen(port, maxConnections, function () {
                        Logger.debug('>> Listening to port ' + port + ', connections queued to ' +
                            maxConnections + ', ' + process.pid + ' >> Server is ready.');
                    });
                });
            }
        } else {
            process.exit('Not a valid server type!');
        }
    });
}
