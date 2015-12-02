/*******************************************************************************
 * Copyright 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *******************************************************************************/
var Probe = require('../lib/probe.js');
var request = require('../lib/request.js');
var util = require('util');
var path = require('path');

function TraceProbe() {
	Probe.call(this, 'trace');
	this.config = {
			includeModules: [],
			excludeModules: []
	};
}
util.inherits(TraceProbe, Probe);

TraceProbe.prototype.attach = function( moduleName, target ) {
    if( moduleName.slice(0,1) != "." || stopList[moduleName] || !isAppInnerRequire() || 
    	this.config.excludeModules.indexOf(moduleName) != -1 ) {
    	return target;
    }
    
    if(target.__ddProbeAttached__) {
    	return target;
    }
    
    var ret = target;
    if (typeof(target) != "function") {
        instrumentMethods(moduleName, target);
    } else {
        instrumentMethods(moduleName, target.prototype);
        ret = target;
		if(Object.keys(target.prototype).length==0 && Object.keys(target).length == 0){
			ret = function () {
				var rc = target.apply(this, arguments);
				instrumentMethods(moduleName, rc);
				return rc;
			}
		}
    }

    ret.__ddProbeAttached__ = function(){return true};
    return ret;
};

var stopList = { "./commands/base_command" : true, "./aspects": true };

function instrument( target, name, method, fullName ) {
var methodString = ''+method;
var methodargs = methodString.toString().split(')')[0].split('(')[1].split(',');
var lastMethodArg = methodargs[methodargs.length-1].replace(/ /g,'');
if(lastMethodArg == '') lastMethodArg = 'undefined';
    var f = function() {
        var instrumentedMethodKNJ = true;
        var req = request.startMethod( fullName );
        var args = arguments;
        var cxtFunc = function() {
            var cxt = {};
            for( var i = 0; i<args.length; ++i ) {
                var arg = args[i];
                var value;
                if( typeof(arg) == "function" && 
			Object.keys(arg).length == 0 && 
                            Object.keys(arg.prototype).length==0) {
                    var fName = arg.name != 0 ? arg.name : '<anonymous>';
                    value = "function " + fName;
                } else if( typeof(arg) == "object" ) {
                    value = "object";
                } else {
                    value = "" + arg;
                }
                cxt["arg"+i] = value;
            }
            return cxt;
        }
        var isCallback = false;
        /*
        if( arguments.length > 0 && typeof(arguments[arguments.length-1]) == "function" && Object.keys(arguments[arguments.length-1]).length == 0) {
        	console.log('Type is ' + typeof(arguments[arguments.length-1].prototype));
        	if (typeof(arguments[arguments.length-1].prototype) === 'object') {
        		console.log('Checking object');
        		console.log(Object.keys(arguments[arguments.length-1].prototype));
        	}
        	else {
        		console.log('Not object');
        	}
        	
        }
        */
        if( arguments.length > 0 && 
        	typeof(arguments[arguments.length-1]) == "function" && 
        	Object.keys(arguments[arguments.length-1]).length == 0 && 
        	// Add to deal with no prototype
        	(!arguments[arguments.length-1].hasOwnProperty('prototype') ||
        	Object.keys(arguments[arguments.length-1].prototype).length == 0) && 
        	methodString.indexOf(lastMethodArg+'.call') < 0 && 
        	methodString.indexOf(lastMethodArg+'.apply')<0 &&
        	(''+arguments[arguments.length-1]).indexOf('instrumentedMethodKNJ')<0
) {
            isCallback = true;
            if (isResponseMethod(arguments)) {
                var resArg = arguments[arguments.length-2];

                var sendCb = resArg.send;
                resArg.send = function() {
                    req.stop(cxtFunc());
                    return sendCb.apply(resArg, arguments);
                }

                var renderCb = resArg.render;
                resArg.render = function() {
                    req.stop(cxtFunc());
                    return renderCb.apply(resArg, arguments);
                }
            } else {
                var cb = arguments[arguments.length-1];
                arguments[arguments.length-1] = function() {
                    req.stop(cxtFunc());
                    cb.apply(this, arguments);
                }
            }
        }
        var res = method.apply(this, arguments);
        if( !isCallback ) {
            req.stop(cxtFunc());
        }
        return res;
    };
    target[name] = f;
    target[name].prototype = method.prototype;
}

function isResponseMethod(args) {
    if (args.length > 1) {
        var arg = args[args.length-2];
        if (typeof(arg) == 'object' && arg!=null && 'send' in arg && 'render' in arg && typeof(arg['send']) == 'function' && typeof(arg['render']) == 'function') {
            return true;
        }
    }
    return false;
}

function traceMethod( moduleName, target, name ) {
    var method = target[name];
    if( method && !method.__ddInstrumented__ ) {
        var fullName = moduleName + "." + name;
//        logger.debug( "instrumenting method", fullName );
        instrument( target, name, method, fullName );

        var p = target[name].prototype;
        for (var item in p) {
            if (typeof(p[item]) == "function" && 
                   Object.keys(p[item]).length==0 && 
                        Object.keys(p[item].prototype).length==0) {
                var itemName = fullName + "." + item;
                instrument(p, item, p[item], itemName);
            }
        }
    }
}

function isAppInnerRequire() {
    var trace = {};
    Error.captureStackTrace(trace);
    var callerLine = trace.stack.split('\n'); // This line contains 'node_modules' reference for generic libs
    return callerLine[6].indexOf('node_modules') == -1;
}

function instrumentMethods(moduleName, target) {
    for( var name in target ) {
        if( !target.__lookupGetter__(name) && typeof(target[name]) == "function" ) {
          if(!target[name].__super__ && 
                         (  !target[name].prototype || 
                                  ( target[name].prototype && Object.keys(target[name].prototype).length==0 ) ) && Object.keys(target[name]).length==0){
            traceMethod(moduleName, target,name);
            }
        }
    }
}

TraceProbe.prototype.enable = function () {};
TraceProbe.prototype.enableRequests = function () {};

module.exports = TraceProbe;