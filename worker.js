/*jslint node:true es5:true*/
'use strict';
var config = require('./hgnode/configurations/config.js'),
    keystore = require('./hgnode/configurations/keystore.js'),
    HgLog = require('./hgnode/framework/HgLog'),
    request = require('request'),
    protocol = config.protocol,
    esbUrl = config.esbUrl,
    webUrl = config.baseUrl,
    clientkey = keystore.WorkerClientKey,
    timeZone = 'America/Chicago',
    time = require('time'),
    fs = require('fs'),
    ONE_HOUR = 3600000,
    getDueJobs = function (callback) {
        var url = protocol + esbUrl + 'esb/Worker/GetDueJobs',
            headers = {clientkey: clientkey};
        request({url : url, headers : headers}, function (error, response, body) {
            if (error) {
                HgLog.error(error);
            } else {
                callback(error, body);
            }
        });
    },
    getFederatedGroups = function (callback) {
        var url = protocol + esbUrl + 'esb/Worker/GetFederatedGroups',
            headers = {clientkey: clientkey};
        request({url : url, headers : headers}, function (error, response, body) {
            if (error) {
                HgLog.error(error);
            } else {
                callback(error, body);
            }
        });
    },
    cleanTempDir = function (dir, done) {
        var results = [];
        if (!dir) {
            dir = [__dirname,  "/static/img/tmp"].join('');
        }
        fs.readdir(dir, function (err, list) {
            if (err) {
                return done(err);
            }
            var pending = list.length;
            if (!pending) {
                return;
            }
            list.forEach(function (file) {
                file = dir + '/' + file;
                fs.stat(file, function (err, stat) {
                    if (stat && stat.isDirectory()) {
                        cleanTempDir(file, function (err, res) {
                            results = results.concat(res);
                            if (!pending - 1) {
                                return;
                            }
                        });
                    } else {
                        if (!file.match(/\.md$/)) {
                            fs.unlink(file, function (err) {
                                if (err) {
                                    HgLog.error(err);
                                    return;
                                }
                            });
                        }
                        if (!pending - 1) {
                            return;
                        }
                    }
                });
            });
        });
    },
    performJob = function (job) {
        var url = protocol + esbUrl + 'esb/Worker/' + job.MethodName,
            headers = {clientkey : clientkey},
            options = {url : url, headers : headers};
        if (job.JobName === 'cleanTempDir') {
            cleanTempDir();
        } else {
            request(options, function (error) {
                if (error) {
                    HgLog.error(job.Name + error);
                }
            });
        }
    },
    federatedGroups = [];

function startOneUnlockESBItemsWorker(group) {
    var url = protocol + esbUrl + 'esb/Worker/UnlockESBItems',
        headers = {clientkey : clientkey},
        options = {
            headers : headers,
            timeout : 600 * 1000
        };
    if (group) {
        url += "?GroupId=" + group.hgId;
    }
    options.url = url;
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 300 * 1000);
}
function unlockESBItemsWorker() {
    federatedGroups.forEach(function (group) {
        startOneUnlockESBItemsWorker(group);
    });
    startOneUnlockESBItemsWorker();
}

function unlockNotificationItemsWorker() {
    var url = protocol + esbUrl + 'esb/Worker/UnlockNotificationQueueItems',
        headers = {clientkey : clientkey},
        options = {
            url : url,
            headers : headers
        };
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, config.UnlockNotificationInterval * 1000);
}
function startOneEventTurkWorker(group) {
    var url = protocol + esbUrl + 'esb/Worker/EventTurk',
        headers = {clientkey : clientkey},
        options = {
            headers : headers,
            timeout : 600 * 1000
        };
    if (group) {
        url += "?GroupId=" + group.hgId;
    }
    options.url = url;
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, config.EventBusInterval * 1000);
}
function eventTurkWorker() {
    federatedGroups.forEach(function (group) {
        startOneEventTurkWorker(group);
    });
    startOneEventTurkWorker();
}
function eventBusRetryOrReport() {
    var url = protocol + esbUrl + 'esb/Worker/EventBusRetryOrReport',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, config.EventBusInterval * 1000);
}
function notificationWorker() {
    var url = protocol + esbUrl + 'esb/Worker/DispatchBatchFromQueue',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, config.DispatchEmailInterval * 1000);
}
function expireUnDownloadedExportedData() {
    var url = protocol + esbUrl + 'esb/Worker/ExpireExportedDownloads',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 3600 * 1000);
}
function expireUnProcessedReports() {
    var url = protocol + esbUrl + 'esb/Worker/ExpireUnProcessedReports',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 60000 * 45);
}
function getServerStatus(type) {
    var url = protocol + type + '/Worker/CheckAppHealth',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 30000); // 30 seconds
}

function processTasks() {
    var url = protocol + esbUrl + 'esb/Worker/ProcessRecurrence',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 30000); // 30 seconds
}

function updateManagerAlerts() {
    var url = protocol + esbUrl + 'esb/Worker/UpdateManagerAlerts',
        headers = {clientkey : clientkey},
        options = {url : url, headers : headers};
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 3600000); // 1 hour
}
getFederatedGroups(function (error, groups) {
    if (error) {
        HgLog.error(error);
    }
    if (typeof groups === 'string') {
        federatedGroups = JSON.parse(groups);
    }
    notificationWorker();
    eventTurkWorker();
    unlockESBItemsWorker();
    unlockNotificationItemsWorker();
    eventBusRetryOrReport();
    expireUnDownloadedExportedData();
    expireUnProcessedReports();
    processTasks();
    updateManagerAlerts();
});

function processProvisionGroup() {
    var url = protocol + esbUrl + 'esb/Worker/ProvisionProcessGroup',
        headers = {clientkey: clientkey},
        options = {
            url: url,
            headers: headers,
            timeout: 600 * 1000
        };
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 30000);
}

function processProvisionLocation() {
    var url = protocol + esbUrl + 'esb/Worker/ProvisionProcessLocation',
        headers = {clientkey: clientkey},
        options = {
            url: url,
            headers: headers,
            timeout: 600 * 1000
        };
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 30000);
}

function processProvisionDepartment() {
    var url = protocol + esbUrl + 'esb/Worker/ProvisionProcessDepartment',
        headers = {clientkey: clientkey},
        options = {
            url: url,
            headers: headers,
            timeout: 600 * 1000
        };
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 30000);
}

function processProvisionMember() {
    var url = protocol + esbUrl + 'esb/Worker/ProvisionProcessMember',
        headers = {clientkey: clientkey},
        options = {
            url: url,
            headers: headers,
            timeout: 600 * 1000
        };
    setInterval(function () {
        request(options, function (error) {
            if (error) {
                HgLog.error(error);
            }
        });
    }, 10000);
}

// checks the tango balance every hour and sends out email if under $7000
function checkTangoBalance() {
    setInterval(function () {
        request({
            url: protocol + esbUrl + 'esb/Worker/CheckTangoAccountBalance',
            headers: { clientkey: clientkey },
            timeout: 600 * 1000
        }, function (err) {
            if (err) {
                HgLog.error(err);
            }
        });
    }, ONE_HOUR);
}

processProvisionGroup();
processProvisionLocation();
processProvisionDepartment();
processProvisionMember();

checkTangoBalance();

//this is only for jobs daily, weekly, monthly. Not for more frequent jobs
setInterval(function () {
    getDueJobs(function (error, dueJobs) {
        if (error) {
            HgLog.error(error);
            return;
        }
        if (dueJobs) {
            if (typeof dueJobs === 'string') {
                dueJobs = JSON.parse(dueJobs);
            }
            dueJobs.forEach(function (job) {
                performJob(job);
            });
        }
    });
}, 300 * 1000);
