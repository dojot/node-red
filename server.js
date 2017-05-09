"use strict";

var express = require('express'),
    MongoClient = require('mongodb').MongoClient,
    bodyParser = require('body-parser'),
    assert = require('assert'),
    translator = require('./translator'),
    request = require('request'),
    util = require('util'),
    config = require('./config'),
    base64 = require('js-base64').Base64;

var db;
var col;

var app = express();
app.use(bodyParser.json());


/**
 * Generates a random ID.
 * @returns A random ID formatted as hexadecimal string.
 */
function sid() {
  const UINT32_MAX = 4294967295;
  return (1 + Math.random()*UINT32_MAX).toString(16);
}

/**
 * Callback function to perseo HTTP requests
 * @param {*} error
 * @param {*} response
 * @param {*} body
 */
function perseoCallback(error, response, body) {
  if (!error && response.statusCode == 200) {
    console.log(util.inspect(body, {showHidden: false, depth: null}));
  } else {
    if (error) {
      console.log(error);
    }
  }
}

/**
 * Callback function to orion HTTP requests
 * @param {*} error
 * @param {*} response
 * @param {*} body
 */
function orionCallback(error, response, body) {
  if (!error && response.statusCode == 200) {
    console.log(util.inspect(body, {showHidden: false, depth: null}));
  } else {
    if (error) {
      console.log(error);
    }
  }
}

function extractFiwareHeaders(flowHeaders) {
  var flowHeader = {};
  for (var header in flowHeaders) {
    if ('authorization' == header.toLowerCase()) {
      let jwData = JSON.parse(base64.decode(flowHeaders[header].split('.')[1]));
      flowHeader = {
        'Fiware-Service': jwData['service'],
        'Fiware-ServicePath': '/'
      }
      break;
    }
  }
  return flowHeader;
}

function addFlow(flowHeaders, flowData, callback) {
  var flowHeader = extractFiwareHeaders(flowHeaders);

  if ((!('id' in flowData)) || (flowData.id.length == 0)) {
    flowData.id = sid();
  }

  if (!('enabled' in flowData)) {
    flowData.enabled = true;
  }

  flowData.created = Date.now();
  flowData.updated = flowData.created;

  // Translate flow to perseo and/or orion
  var flowRequests = translator.translateMashup(flowData.flow);
  // Store perseo data so that the rules can be properly removed in the future
  flowData['perseoRules'] = {
    headers : {}, // Headers used to create these rules (and so to remove them)
    rules : []    // List of rule identifiers
  };

  if ('perseoRequests' in flowRequests) {
    // Send the requests
    for (var i = 0; i < flowRequests.perseoRequests.length; i++) {
      let flowRequest = flowRequests.perseoRequests[i];
      request.post({url: config.perseo_fe.url + '/rules', json: flowRequest.perseoRequest, headers: flowHeader}, perseoCallback);
      flowData.perseoRules.rules.push(flowRequest.ruleName);
    }
    flowData.perseoRules.headers = flowHeader;
  }

  if ('orionRequests' in flowRequests) {
    // Send the requests
    for (var i = 0; i < flowRequests.orionRequests.length; i++) {
      let flowRequest = flowRequests.orionRequests[i];
      request.post({url: config.orion.url + '/updateContext/', json: flowRequest, headers: flowHeader}, orionCallback);
    }
  }

  if ('orionSubscriptions' in flowRequests) {
    // Send the requests
    for (var i = 0; i < flowRequests.orionSubscriptions.length; i++) {
      let flowRequest = flowRequests.orionSubscriptions[i];
      request.post({url: config.orion.url + '/subscribeContext/', json: flowRequest, headers: flowHeader}, orionCallback);
    }
  }

  col.insertOne(flowData, function(err, result) {
    callback(err);
    return;
  });
}

function deleteFlow(flowid, callback) {
  // Removing related rules
  col.findOne({id: flowid}, function(err, flow) {
    if (err) {
      // An error ocurred
      callback(err, 0);
      return;
    }

    // Remove all perseo rules related to this flow
    if (flow != null) {
      for (var i = 0; i < flow.perseoRules.rules.length; i++) {
        let flowId = flow.perseoRules.rules[i];
        let flowHeader = flow.perseoRules.headers;
        request.delete({url: config.perseo_fe.url + "/rules/" + flowId, headers: flowHeader}, perseoCallback);
      }
      col.remove({id: flowid}, null, function(err, nRemoved) {
        callback(err, nRemoved);
        return;
      });
    } else {
      // There is no such element in the database.
      callback(null, 0);
      return;
    }
  })
}


//
// GET handler
//
app.get('/v1/flow', function (req, res) {
  col.find({}, {_id: 0}).toArray(function (err, flows) {
    if (err) {
      res.status(500).send({msg: 'failed to retrieve data'});
      throw err;
    }
    res.status(200).send(flows);
  })
})

//
// POST handler
//
app.post('/v1/flow', function (httpRequest, httpResponse) {
  let flowData = httpRequest.body;
  let flowHeaders = httpRequest.headers;

  if (!flowData) {
    httpResponse.status(400).send({msg: "missing flow data"});
    return;
  }

  addFlow(flowHeaders, flowData, function(err) {
    if (err) {
      httpResponse.status(500).send({msg: 'failed to insert data'});
      throw err;
    }
    httpResponse.status(200).send({msg: 'flow created ', flow: flowData});
  });
})

//
// DELETE handler
//
app.delete('/v1/flow', function (req, res) {
  col.find().forEach(function(flowData) {
    for (var i = 0; i < flowData.perseoRules.rules.length; i++) {
      let flowId = flowData.perseoRules.rules[i];
      let flowHeader = flowData.perseoRules.headers;
      request.delete({url: config.perseo_fe.url + "/rules/" + flowId, headers: flowHeader}, perseoCallback);
    }
  });
  col.remove();
  res.status(200).send({msg: 'all flows removed'})
})


//
// GET handler - single version
//
app.get('/v1/flow/:flowid', function (req, res) {
  col.findOne({id: req.params.flowid}, function(err, flow) {
    if (err) {
      res.status(500).send({msg: 'failed to retrieve data'});
      throw err;
    }
    res.status(200).send({msg: 'ok', flow: flow});
  })
})


//
// PUT handler - single version
//
app.put('/v1/flow/:flowid', function (httpRequest, httpResponse) {

  let flowData = httpRequest.body;
  let flowHeaders = httpRequest.headers;

  if (!flowData) {
    httpResponse.status(400).send({msg: "missing flow data"});
    return;
  }

  deleteFlow(httpRequest.params.flowid, function(err, nRemoved) {
    if (err) {
      httpResponse.status(500).send({msg: 'failed to remove flow'});
      throw err;
    }
    if (nRemoved === 0) {
      httpResponse.status(404).send({msg: 'given flow is unknown'});
      return;
    }
    addFlow(flowHeaders, flowData, function(err) {
      if (err) {
        httpResponse.status(500).send({msg: 'failed to insert data'});
        throw err;
      }
      httpResponse.status(200).send({msg: 'flow updated', flow: flowData});
      return;
    });
  });
})


//
// DELETE handler - single version
//
app.delete('/v1/flow/:flowid', function (req, res) {
  deleteFlow(req.params.flowid, function(err, nRemoved) {
    if (err) {
      res.status(500).send({msg: 'failed to remove flow'});
      throw err;
    }
    if (nRemoved === 0) {
      res.status(404).send({msg: 'given flow is unknown'});
    }
    res.status(200).send({msg: 'flow removed', id: req.params.flowid});
  })
})

var url = config.mongo.url;
var opt = {
  connectTimeoutMS: 2500,
  reconnectTries: 100,
  reconnectInterval: 2500,
  autoReconnect: true
}

MongoClient.connect(url, opt, function (err, database) {
  if (err) throw err;

  db = database;
  col = db.collection('flows');
  col.ensureIndex({id: 1}, {unique: true});
  app.listen(3000, function () {
    console.log('Flow service started');
  })
})
