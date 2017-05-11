var HGCache = require('./hgnode/framework/RedisConnectionCache'),
    ConstantEnums = require('./hgnode/enums/ConstantEnums'),
    cryptoHelper = require('./hgnode/helpers/cryptoHelper.js'),
    config = require('./hgnode/configurations/config.js'),
    HgLog = require('./hgnode/framework/HgLog.js'),
    allClients = [],
    sanitize = function (string) {
        return string.replace(/\\n/g, "\\n")
            .replace(/\\'/g, "\\'")
            .replace(/\\"/g, '\\"')
            .replace(/\\&/g, "\\&")
            .replace(/\\r/g, "\\r")
            .replace(/\\t/g, "\\t")
            .replace(/\\b/g, "\\b")
            .replace(/\\f/g, "\\f");
    },
    requestHandler = {
        get: function(params, callback){
            var respData,
                decryptedString;
            HGCache.GlobalGet(params.key, function(err, data) {
                if (err) {
                    HgLog.info('*** Redis Error: ' + err.toString() + '***');
                    return callback(null, {
                        event: params.event,
                        data: null
                    });
                }
                try {
                    if (data) {
                        decryptedString = cryptoHelper.decrypt(
                            new Buffer(
                                new Buffer(data, 'hex'), 'utf8')).toString('utf8');
                        respData = JSON.parse(decryptedString);
                    } else {
                        respData = null;
                    }
                } catch (err) {
                    HgLog.error('Error string : ' + decryptedString);
                    HgLog.error(err + ' : ' + respData);
                } finally {
                    callback(null, {
                        event: params.event,
                        data: respData
                    });
                }
            });
        },
        save: function(params, callback){
            var jsonString;
            if (params.data) {
                jsonString = sanitize(JSON.stringify(params.data || ''));
                HGCache.GlobalSet(params.key, cryptoHelper.encrypt(new Buffer(jsonString, 'utf8')).toString('hex'), function(err, success) {
                    if (err) {
                        HgLog.info('*** Redis Error: ' + err.toString() + '***');
                        return callback(null, {
                            event: params.event,
                            success: false
                        });
                    }
                    callback(null, {
                        event: params.event,
                        success: success
                    });
                }, ConstantEnums.SECONDS_IN_TWENTY_FOUR_HOURS);
            } else {
                callback(null, {
                    event: params.event
                });
            }

        },
        clear: function(params, callback){
            HGCache.GlobalDelete(params.key, function(err, success) {
                if (err) {
                    HgLog.info('*** Redis Error: ' + err.toString() + '***');
                    return  callback(null, {
                        event: params.event,
                        success: false
                    });
                }
                callback(null, {
                    event: params.event,
                    success: success
                });
            });
        }
    };
function process(params, callback){
    var msg = JSON.parse(params.message),
    key = !msg.ispublic ? params.token + msg.event : msg.event;
    requestHandler[msg.method]({
        key: key,
        event: msg.event,
        data: msg.data
    }, callback);
}
function addWs(ws) {
    allClients.push(ws);
}
function removeWs(ws) {
    var i = allClients.indexOf(ws);
    delete allClients[i];
}
function message(params, callback){
    process(params.request, params.token, function(err, data){
        callback(err, data);
    });
}
function pong(ws){
    return setInterval(function(){
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({event: 'ping', success: true}));
        }
    }, 20000);
}
function listen(ws){
    addWs(ws);
    var token = ws.upgradeReq.query.userToken,
        ping = pong(ws);

    ws.on('message', function(msg) {
        process({
            message: msg,
            token: token
        },function(err, data){
            if (err) {
                ws.send(JSON.stringify({error: err}));
            } else{
                ws.send(JSON.stringify(data));
            }
        });
    });
    ws.on('disconnect', function(ws){
        clearInterval(ping);
        removeWs(ws);
    });
}
module.exports = {
    listen: listen
};