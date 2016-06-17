/*
 * This file is part of AdSidebar <http://adsidebar.com/>,
 * Copyright (C) 2016 Paul Shaw
 *
 * AdSidebar is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * AdSidebar is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdSidebar.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * @fileOverview Adsidebar implementation
*/

"use strict";

try
{
  // Hack: SDK loader masks our Components object with a getter.
  let proto = Object.getPrototypeOf(this);
  let property = Object.getOwnPropertyDescriptor(proto, "Components");
  if (property && property.get)
    delete proto.Components;
}
catch (e)
{
  Cu.reportError(e);
}

let {XPCOMUtils} = Cu.import("resource://gre/modules/XPCOMUtils.jsm", {});
let {Services} = Cu.import("resource://gre/modules/Services.jsm", {});

let {Utils} = require("utils");
let {consolelog} = require("child/utils");

let {Ads} = require("child/adsidebar/ads");


// LOCAL FUNCTIONS

/**
 * handleScriptError
 */
function handleScriptError(adsidebar)
{

    if (!adsidebar.scriptErrorFlag) {
        return;
    }

    if (adsidebar.handleScriptError) {
        return;
    }

    adsidebar.handleScriptError = true;
    
    let wnd = adsidebar.wnd;
    let doc = wnd.document;

    let scriptArray = [];

    if (adsidebar.runlocalscripts) {
        // if script error occurred, re-run inline scripts.
        // The error is most likely due to prior blocking of external script loading.

        let elementList = doc.getElementsByTagName("script");
        for (let i = 0; i < elementList.length; i++) { 
            let scriptNode = elementList[i];
            if (!scriptNode.src) {
                scriptArray.push(scriptNode);
            }
        }
    }

    if (adsidebar.overridejqueryready) {
        // override jquery ready
        if (wnd.wrappedJSObject.jQuery) {
            wnd.wrappedJSObject.jQuery.fn.ready = function(fn) {
                fn();
            };
        }
    }        

    if (adsidebar.runlocalscripts) {
        for (let scriptNode of scriptArray) {
        
            // for the script node to be excecuted again, must create a new script node
            let scriptNew   = doc.createElement("script");
            scriptNew.type  = scriptNode.type;
            scriptNew.async = scriptNode.async;
            scriptNew.innerHTML = scriptNode.innerHTML;
            
            // insert new div node into ad container DIV
            Ads.insertNewNode(adsidebar.ads, scriptNew);
        }      
    }        

    if (adsidebar.refreshgpt) {
        // refresh GPT ads if script error occurred
        if (wnd.wrappedJSObject.googletag) {
            let pubads = wnd.wrappedJSObject.googletag.pubads;
            if (pubads) {
                pubads().refresh();                    
            }
        }
    }        
}    

/**
 * nodeAddEventListeners
 */
function nodeAddEventListeners(adsidebar, node) 
{
    if (adsidebar.lastScriptNode) {
        nodeRemoveEventListeners(adsidebar, adsidebar.lastScriptNode);            
    }
    
    adsidebar.lastScriptNode = node;
    
    node.addEventListener("load", nodeLoaded.bind(this, adsidebar, node), false);
    node.addEventListener("error", nodeError.bind(this, adsidebar, node), false);
}

/**
 * nodeRemoveEventListeners
 */
function nodeRemoveEventListeners(adsidebar, node) 
{
    // remove event listeners
    node.removeEventListener("load", nodeLoaded, false);
    node.removeEventListener("error", nodeError, false);
    
    adsidebar.lastScriptNode = null;
}
    
/**
 * nodeLoaded
 */
function nodeLoaded(adsidebar, node) 
{
            
    nodeRemoveEventListeners(adsidebar, node)
    
    NodeQueue.processNodeQueue(adsidebar);
}

/**
 * nodeError
 */
function nodeError(adsidebar, node) 
{
    
    nodeRemoveEventListeners(adsidebar, node)
    
    NodeQueue.processNodeQueue(adsidebar);
}

/**
 * processNodeQueueComplete
 */
function processNodeQueueComplete(adsidebar)
{
    
    adsidebar.notifyNodeQueueComplete(adsidebar);
            
    
    adsidebar.notifyAdLoadingStarted(adsidebar);
    
    // handle any script errors
    handleScriptError(adsidebar);
}
   

// EXPORTED FUNCTIONS

let NodeQueue = exports.NodeQueue =
{
 
    /**
     * processNodeQueue
     */
    processNodeQueue : function (adsidebar)
    {
        
        let wnd = adsidebar.wnd;
        if (!wnd) {
            return;
        }
        
        
        let doc = wnd.document;
    
        if (!doc) {
            return;
        }
        
        // dequeue node
        let nodeInfo = adsidebar.nodeQueue.shift();
      
        if (!nodeInfo) {
            // we're done
            processNodeQueueComplete(adsidebar);
            return;            
        }
      
        if (nodeInfo.node) {
            // non-script node
            let node = nodeInfo.node;
            
            if (Cu.isDeadWrapper(node)) {
                adsidebar.stats.numDeadNodes++;
                
                // process next node in the queue 
                this.processNodeQueue(adsidebar);
                return;   
            }


            if (node.nodeName == "IFRAME") {
                // process iframe

                // add event listener that will process next node after iframe is loaded
                nodeAddEventListeners(adsidebar, node);
                
                if (node !== doc) {
                    // insert node into ad container div
                    Ads.insertNewNode(adsidebar.ads, node);
                }
                
            } else {
                if (node !== doc) {
                    // insert node into ad container div
                    Ads.insertNewNode(adsidebar.ads, node);
                }
                
                // process next node in the queue 
                this.processNodeQueue(adsidebar);
            }
            
            
        } else {
            
            // script node

            // for the script node to be excecuted again, must create a new script node
            let script   = doc.createElement("script");
            
            // add event listener to execute when script loaded
            // - will dequeue the next node
            nodeAddEventListeners(adsidebar, script);
            
            script.type  = nodeInfo.scriptInfo.type;
            script.src   = nodeInfo.scriptInfo.src;
            script.async = nodeInfo.scriptInfo.async;
            script.id    = nodeInfo.scriptInfo.id; 
            
            // create div to hold script
            let div   = doc.createElement("div");

            // insert new script node into div
            div.appendChild(script);

            // Reroute document.write
            // document.write is a no-op after the document is loaded.
            // Reroute so document.write can be used by scripts to create new nodes etc.
            wnd.wrappedJSObject.document.write = function(div, adsidebar, str) {
                
                    adsidebar.stats.numDocWrites++;

                    adsidebar.documentWriteString += str;
                                    
                    // script will not run if insertAdjacentHTML is used (even with defer = true)
                    // use createContextualFragment instead
                    let range = doc.createRange();
                    let docFragmentToInsert = range.createContextualFragment(adsidebar.documentWriteString);

                    if (docFragmentToInsert.childNodes.length == 0) {
                        // no valid nodes, assume document.write will be called again
                    } else {
                        // valid nodes
                        
                        adsidebar.documentWriteString = "";
                                                
                        // insert into div
                        div.appendChild(docFragmentToInsert);
                        
                        // add dummy <script> which will be used to add a "load" event listener
                        // which will signal the document fragment has loaded.

                        let dummyScriptStr = "<script></script>";
                        range = doc.createRange();
                        docFragmentToInsert = range.createContextualFragment(dummyScriptStr);
                        
                        // add event listener to dummy script node
                        nodeAddEventListeners(adsidebar, docFragmentToInsert.firstElementChild);

                        // insert into div
                        div.appendChild(docFragmentToInsert);
                    } 
    
                }.bind(this, div, adsidebar);

            // insert new div node into ad container div
            Ads.insertNewNode(adsidebar.ads, div);
        }
         
    },
};

