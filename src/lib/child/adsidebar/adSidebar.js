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
let {NodeQueue} = require("child/adsidebar/nodeQueue");
   
/**
 * Contains adsidebar object mapped by window object
 * @type Map.<adsidebar,window>
 */
let adsidebarMap = new Map();

// adsidebar.state
const ADSIDEBAR_STATE_INIT                   = 0;
const ADSIDEBAR_STATE_WINDOW_LOAD            = 1;
const ADSIDEBAR_STATE_PROCESS_NODES_START    = 2;
const ADSIDEBAR_STATE_PROCESS_NODES_COMPLETE = 3;       // all nodes moved to adsidebar DIV
const ADSIDEBAR_STATE_ADLOAD_START           = 4;       // wait for sidebar DIV nodes to load resources  
const ADSIDEBAR_STATE_ADLOAD_COMPLETE        = 5;       // display adsidebar DIV
const ADSIDEBAR_STATE_DONE                   = 6;       // done - assume all sidebar ads are loaded and     
                                                        // dynamic ad processing can commence
                                                        
                                                        
let adsidebar_prefs = {
    enabled : null,
    adsidebar_autohide : null,      // seconds, 0 is disabled
    adsidebar_adScaling : null,
};
                                                               

// MESSAGE HANDLING

addMessageListener("AdblockPlus:AdsidebarDataRequest", onAdsidebarDataRequest);
onShutdown.add(() => {
  removeMessageListener("AdblockPlus:AdsidebarDataRequest", onAdsidebarDataRequest);
});

function onAdsidebarDataRequest(message)
{
    let {outerWindowID, responseID} = message.data;
    let wnd = Services.wm.getOuterWindowWithId(outerWindowID);
    
    if (wnd) {
        let data = {
            sidebarEnabled : false,
            sidebarDisplayed : false,
        };
        
        let adsidebar = adsidebarMap.get(wnd);
        if (adsidebar) {
            data.sidebarEnabled = adsidebar.ads.stats.numAds ? true : false;
            data.sidebarDisplayed = adsidebar.sidebarDisplayed;
        }
        
        sendAsyncMessage("AdblockPlus:AdsidebarDataResponse", {
            responseID,
            data
            });
         
    }
}

addMessageListener("AdblockPlus:AdsidebarToggleSidebar", onAdsidebarToggleSidebar);
onShutdown.add(() => {
  removeMessageListener("AdblockPlus:AdsidebarToggleSidebar", onAdsidebarToggleSidebar);
});

function onAdsidebarToggleSidebar(message)
{
    let {outerWindowID} = message.data;
    let wnd = Services.wm.getOuterWindowWithId(outerWindowID);
    
    if (wnd) {
        let adsidebar = adsidebarMap.get(wnd);
        if (adsidebar) {
            
            if (adsidebar.sidebarDisplayed) {
                hideSidebar(adsidebar);
            } else {
                showSidebar(adsidebar);
            }
        }    
    }
}


addMessageListener("AdblockPlus:AdsidebarUpdateChildPrefs", onAdsidebarUpdateChildPrefs);
onShutdown.add(() => {
  removeMessageListener("AdblockPlus:AdsidebarUpdateChildPrefs", onAdsidebarUpdateChildPrefs);
});

function onAdsidebarUpdateChildPrefs(message)
{
    let {prefs} = message.data;

    adsidebar_prefs.enabled = prefs.enabled;
    adsidebar_prefs.adsidebar_autohide = prefs.adsidebar_autohide;
    adsidebar_prefs.adsidebar_adScaling = prefs.adsidebar_adScaling;
    
}


// LOCAL FUNCTIONS

/**
 * windowInit
 */
function windowInit(wnd)
{
    
    if (wnd != wnd.top) {
        return;
    }
    
    if (adsidebarMap.has(wnd)) {
        return;
    }
            
    // create new adsidebar object. Map window top => adsidebar object
    adsidebarMap.set(wnd,
                        {
                            wnd  : wnd,
                            ads  : null,                // for use by Ads module
                            sidebarDiv : null,          // div that holds title menu + adDiv
                            titleIFrame : null,         // title menu (iframe)
                            sidebarExpanded : false,
                            sidebarDisplayed : false,
                            timeoutId : null,           // timeout for closing sidebar       
                            maxWidth : 800,
                            maxHeight : 600,
                            state : ADSIDEBAR_STATE_INIT,  
                            
                            hits : [],                 // CSS selector of elements to hide
                            nodeQueue : [],            // blocked nodes (e.g. script nodes)
                            lastScriptNode : null,     // "load" event bound to this node
                            scriptErrorFlag : false, 
                            handleScriptError : false,
                            refreshgpt : false,
                            runlocalscripts : false,
                            overridejqueryready : false,
                            documentWriteString : "",
                            
                            notifyNodeQueueComplete : null,
                            notifyAdLoadingStarted : null,
                            notifyAdLoadingComplete : null,
                                                        
                            stats : {
                                numDocWrites : 0,
                                numDeadNodes : 0,
                            }    
                        });
    
    wnd.addEventListener("load", windowLoad.bind(this, wnd), false);
    
    // document "load" event doesn't work, but DOMContentLoaded and readystatechange do.
    // For debug purposes.
    wnd.document.addEventListener("DOMContentLoaded", 
        function (wnd) {
        }.bind(this, wnd), false);
    
    wnd.document.addEventListener("readystatechange", 
            function (wnd) {
            }.bind(this, wnd), false);        
    
    wnd.addEventListener("unload", windowUnload.bind(this, wnd), false);
    wnd.addEventListener("error", windowError.bind(this, wnd), false);

    let adsidebar = adsidebarMap.get(wnd);
    
    if (adsidebar) {
        // check for Adsidebar per website filters
        let contentType = null;
        let location = wnd.document.URL;
        let {foundMatch, refreshgpt, runlocalscripts, overridejqueryready} = 
            sendSyncMessage("AdblockPlus:MatchAdsidebarList", {
                contentType,
                location,
                frames: null,
                isPrivate: null});
        adsidebar.refreshgpt = refreshgpt;
        adsidebar.runlocalscripts = runlocalscripts;
        adsidebar.overridejqueryready = overridejqueryready;
        
        if (foundMatch) {
        }            
    }
    
    // init ads module
    Ads.windowInit(adsidebar);
    
    // register notification functions
    adsidebar.notifyNodeQueueComplete = function (adsidebar) { 
                adsidebar.state = ADSIDEBAR_STATE_PROCESS_NODES_COMPLETE;
            }.bind(this, adsidebar);
            
    adsidebar.notifyAdLoadingStarted =  function (adsidebar) { 
                adsidebar.state = ADSIDEBAR_STATE_ADLOAD_START;
            }.bind(this, adsidebar);
            
    adsidebar.notifyAdLoadingComplete =  function (adsidebar) { 
                adLoadingComplete(adsidebar);
            }.bind(this, adsidebar);
            
}

/**
 * windowLoad   
 */
function windowLoad(wnd)
{

    let doc = wnd.document;
    
    if (!doc) {
        return;
    }

    let adsidebar = adsidebarMap.get(wnd);
    if (!adsidebar) {
        return;
    }

    // new state declares that nodes should no longer be blocked
    // this allows ad script to be loaded
    adsidebar.state = ADSIDEBAR_STATE_WINDOW_LOAD;

    // create sidebar
    createSidebar(adsidebar);
    
    // notify ads module that the document has loaded
    Ads.windowLoad(adsidebar.ads);
    
    
    adsidebar.state = ADSIDEBAR_STATE_PROCESS_NODES_START;
    
    // Process blocked node queue sequentially
    //      - dequeue node (e.g. script node)
    //      - create new script node. Add "load" event listener.
    //      - On "load" event
    //              dequeue next node
    //              if no more nodes, call processNodeQueueComplete()
    if (adsidebar.nodeQueue.length) {
        NodeQueue.processNodeQueue(adsidebar);
    } 
}

/**
 * windowUnload
 */
function windowUnload(wnd)
{

    let adsidebar = adsidebarMap.get(wnd);

    if (adsidebar) {
        // notify ads module
        Ads.windowUnload(adsidebar.ads);
    }        
    
    adsidebarMap.delete(wnd);
}

/**
 * windowError
 */
function windowError(wnd, e)
{

    let adsidebar = adsidebarMap.get(wnd);

    // record error.  Likely a script error (undefined variable or function)        
    if (adsidebar) {
        adsidebar.scriptErrorFlag = true;
    }
}

/**
 * hideSidebar
 */
function hideSidebar(adsidebar)
{
    // hide adsidebar div
    if (adsidebar.sidebarExpanded) {
        adsidebar.sidebarDiv.style.right = -adsidebar.maxWidth + 'px';
    } else {
        adsidebar.sidebarDiv.style.right = -adsidebar.ads.adBoxWidth + 'px';
    }
    adsidebar.sidebarDisplayed = false;
}

/**
 * showSidebar
 */
function showSidebar(adsidebar)
{
    // show adsidebar div
    adsidebar.sidebarDisplayed = true;
    adsidebar.sidebarDiv.style.right = '0px';
}



/**
 * createSidebar
 */
function createSidebar(adsidebar)
{
    
    let wnd = adsidebar.wnd;
    let doc = wnd.document;

    // Create sidebar 
    //
    // Sidebar is composed of the following DIVs
    //
    //      sidebarDiv
    //          titleIFrame
    //          adContainerDiv
    //
    let sidebarDiv = doc.createElement('div');
    
    sidebarDiv.id = 'adsidebar_container';
    
    let bkColor = wnd.getComputedStyle(doc.body, null).backgroundColor;
    if (!bkColor || bkColor == 'transparent') {
        bkColor = 'white';
    }
    sidebarDiv.style.backgroundColor = bkColor;
    sidebarDiv.style.position = 'fixed';
    sidebarDiv.style.right = -adsidebar.maxWidth + 'px'      // negative is off-screen
    sidebarDiv.style.top = '0px';
    sidebarDiv.style.width = adsidebar.maxWidth + 'px';
    sidebarDiv.style.height = 'auto';
    sidebarDiv.style.overflow = 'hidden';
    sidebarDiv.style.zIndex = 2147483647; //Number.MAX_SAFE_INTEGER;
                                
    sidebarDiv.style.transition = 'right 1s';      // animation
    
    // add title bar
    let request = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Components.interfaces.nsIXMLHttpRequest);
                        
    request.open("GET", "resource://adsidebar/adsidebar_title.html", false );
    request.send();
    
    if (request.responseText) {
        let titleIFrame = doc.createElement('iframe');
        
        // on iframe load, add event listners to buttons
        titleIFrame.addEventListener("load", 
            function(adsidebar) {
                // style iframe
                titleIFrame.width = adsidebar.ads.adBoxWidth + "px";
                titleIFrame.height = titleIFrame.contentDocument.body.clientHeight + "px";
                titleIFrame.style.margin = "0px";
                titleIFrame.style.border = "0px";
                titleIFrame.style.width = adsidebar.ads.adBoxWidth + "px";
                titleIFrame.style.height = titleIFrame.contentDocument.body.clientHeight + "px";

                // style iframe.document                    
                titleIFrame.contentDocument.body.style.overflow = "hidden";

                // if sidebar width is small, remove title text                    
                if (adsidebar.ads.adBoxWidth < 150) {
                    let titleTextNode = titleIFrame.contentDocument.querySelector("#adsidebar_title_text");
                    titleTextNode.parentElement.removeChild(titleTextNode);
                }
                
                // add event listeners to buttons
                let closeButton = titleIFrame.contentDocument.querySelector("#adsidebar_close_button");
                if (closeButton) {
                    closeButton.addEventListener("click",
                        function (adsidebar) {
                            hideSidebar(adsidebar);
                        }.bind(this, adsidebar), false);
                }
                
                let expandButton = titleIFrame.contentDocument.querySelector("#adsidebar_expand_button");
                if (expandButton) {
                    expandButton.addEventListener("click",
                        function (adsidebar) {
                            
                            if (adsidebar.sidebarExpanded) {
                                // collapse the sidebar
                                adsidebar.sidebarExpanded = false;

                                sidebarDiv.style.width = adsidebar.ads.adBoxWidth + "px";
                                titleIFrame.width = adsidebar.ads.adBoxWidth + "px";
                                titleIFrame.style.width = adsidebar.ads.adBoxWidth + "px";
                
                                let expandImg = titleIFrame.contentDocument.querySelector("#adsidebar_expand_img");
                                if (expandImg) {
                                    expandImg.src = "resource://adsidebar/adsidebar-icon-expand.png"
                                }

                                // style ad dividers
                                Ads.notifySidebarCollapsed(adsidebar.ads);
                                
                            } else {
                                // expand the sidebar
                                adsidebar.sidebarExpanded = true;

                                adsidebar.sidebarDiv.style.width = adsidebar.maxWidth + 'px';
                                titleIFrame.width = adsidebar.maxWidth + 'px';
                                titleIFrame.style.width = adsidebar.maxWidth + "px";

                                // change button to collapse image
                                let expandImg = titleIFrame.contentDocument.querySelector("#adsidebar_expand_img");
                                if (expandImg) {
                                    expandImg.src = "resource://adsidebar/adsidebar-icon-collapse.png"
                                }

                                // style ad dividers
                                Ads.notifySidebarExpanded(adsidebar.ads);
                            }
                            
                        }.bind(this, adsidebar), false);
                }

            }.bind(this, adsidebar), false);
        
        // append title iframe to adsidebar DIV
        titleIFrame.srcdoc = request.responseText;
        
        sidebarDiv.appendChild(titleIFrame);
        adsidebar.titleIFrame = titleIFrame;
    }
    
    // insert sidebar DIV into DOM
    doc.body.insertBefore(sidebarDiv, doc.body.firstChild);
    adsidebar.sidebarDiv = sidebarDiv;
        
}


/**
 * adLoadingComplete
 */
function adLoadingComplete(adsidebar)
{
    let wnd = adsidebar.wnd;

    adsidebar.state = ADSIDEBAR_STATE_ADLOAD_COMPLETE;

    // when hidden, sidebar DIV is 800px wide.  Set to correct width before unhiding.
        
    if (adsidebar.sidebarExpanded) {
        adsidebar.sidebarDiv.style.width = adsidebar.maxWidth + 'px';
        
    } else {
        adsidebar.sidebarDiv.style.width = adsidebar.ads.adBoxWidth + "px";
    }
    
    // show adsidebar div
    showSidebar(adsidebar);
    
    // some websites modify this. Make sure zIndex is correct.
    adsidebar.sidebarDiv.style.zIndex = 2147483647;

    // automatically hide the sidebar after a specified number of seconds 
    let timeoutMsec = adsidebar_prefs.adsidebar_autohide * 1000;
    if (timeoutMsec) {
       function hideSidebarTimeout() 
       {
            adsidebar.sidebarDiv.removeEventListener("mouseover", mouseoverEventFunc, false);
            adsidebar.sidebarDiv.removeEventListener("mouseout", mouseoutEventFunc, false);
           
            // hide adsidebar div
            hideSidebar(adsidebar);
        };

        // start timeout  (restart if timeout in progress)
        if (adsidebar.timeoutId) {
            adsidebar.wnd.clearTimeout(adsidebar.timeoutId);
        }
        adsidebar.timeoutId = wnd.setTimeout(hideSidebarTimeout.bind(this), timeoutMsec);

        // cancel timeout if user moves mouse over adsidebar
        function mouseoverEventFunc() 
        {
            adsidebar.wnd.clearTimeout(adsidebar.timeoutId);
            adsidebar.timeoutId = null;
        };
        adsidebar.sidebarDiv.addEventListener("mouseover", mouseoverEventFunc, false);
        
        // restart timeout if user moves mouse out of adsidebar
        function mouseoutEventFunc() {
            adsidebar.timeoutId = wnd.setTimeout(hideSidebarTimeout.bind(this), timeoutMsec);
        }
        adsidebar.sidebarDiv.addEventListener("mouseout", mouseoutEventFunc, false);
    }       
    
    adsidebar.state = ADSIDEBAR_STATE_DONE;
    logDebugInfo(adsidebar); 
    
} 

/**
 * logDebugInfo
 */
function logDebugInfo (adsidebar) 
{
    
}


// EXPORTED FUNCTIONS

let Adsidebar = exports.Adsidebar =
{
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference]),

    adsidebar_prefs : adsidebar_prefs,
    
    /**
     * init
     */
    init: function()
    {
        
        Services.obs.addObserver(this, "content-document-global-created", true);
        
        onShutdown.add(() =>
        {

            Services.obs.removeObserver(this, "content-document-global-created");
        });
    },


    /**
     * Processes parent's response to the ShouldAllow message.
     * @param {nsIDOMWindow} wnd window that the request is associated with
     * @param {nsIDOMElement} node  DOM element that the request is associated with
     * @param {Object|undefined} response  object received as response
     * @return {Boolean} false if the request should be blocked
     */
    processPolicyResponse : function(wnd, node, response)
    {  
        let {allow, collapse, hits} = response;
        
        if (!adsidebar_prefs.enabled) {
            return allow;
        }
        
        if (!allow) {
            
            for (let hit of hits)
            {
            }
            
            let wndtop = wnd.top;
            
            if (!adsidebarMap.has(wndtop)) {
                
                return allow;
            }

            let adsidebar = adsidebarMap.get(wndtop);

            if (adsidebar.state >= ADSIDEBAR_STATE_WINDOW_LOAD) {
                if (!adsidebar.sidebarDiv) {
                    // if window loaded, but adsidebar disabled => block all nodes
                    allow = false;
                } else {
                    
                    // After window loads
                    // - allow new nodes to load so that ads display correctly 
                    // - dynamic ad support (e.g. ads insert after page loaded)
                    //      check for filter = elemhide, find new nodes, move to adsidebar
                    
                    allow = true;
                    
                    // add filterType = elemHide to hits array
                    adsidebar.hits = adsidebar.hits.concat(hits);
         
                    if (adsidebar.state >= ADSIDEBAR_STATE_ADLOAD_COMPLETE) {
                        // dynamic ad processing
                        Ads.insertNewNodeDynamic(adsidebar.ads, node, hits);
                    }

                    
                }
                
            } else {
                // state < ADSIDEBAR_STATE_WINDOW_LOAD
                //      Before page loads, queue and block all nodes.
                //      The nodes will be reinserted after the page loads.
                
                // If script node, instead of storing reference to node,
                // store script information.
                // On some websites, the script node's parent is the document.head
                // and when the script does not load, the script node is deleted.
                // Any subsequent references become "cannot access dead node".
                // To fix this
                //    - Copy script information, rather than store a reference to the script node.
                // The is ok for script nodes as a new script node must be allocated anyway 
                // for the script to run again.  If the node is simply append to the DOM, the script
                // will not run.    
                
                let nodeInfo = {
                    node : null,
                    
                    scriptInfo : {
                        type : 0,
                        src  : null,
                        async : null,
                        id    : null                     
                    }
                };
                
                
                if (node.nodeName == "SCRIPT") {
                    nodeInfo.scriptInfo.type    = node.type;
                    nodeInfo.scriptInfo.src     = node.src;
                    nodeInfo.scriptInfo.async   = node.async;
                    nodeInfo.scriptInfo.id      = node.id;
                } else {
                    nodeInfo.node = node;
                }

                adsidebar.hits = adsidebar.hits.concat(hits);
                adsidebar.nodeQueue.push(nodeInfo);
            }
        }

        return allow;
    },
    
    //
    // nsIObserver interface implementation
    //
    observe: function(subject, topic, data, additional)
    {
        if (topic != "content-document-global-created") {
            return;
        }
        if (!(subject instanceof Ci.nsIDOMWindow)) {
          return;
        }
        
        // must be top level window
        if (subject != subject.top) {
            return;
        }

        try
        {
            let wnd = subject;
            if (wnd) {
                windowInit(wnd);
            }                
        }
        catch (e)
        {
            Cu.reportError(e);
        }
    },

};

Adsidebar.init();