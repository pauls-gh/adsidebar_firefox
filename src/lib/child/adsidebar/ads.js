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
 * @fileOverview Ad processing implementation
 *               - manage ad container DIV
 *               - manage adinfo array
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


// ads.state
const ADS_STATE_INIT                   = 0;
const ADS_STATE_WINDOW_LOADED          = 1;
const ADS_STATE_ADS_LOADING            = 2;
const ADS_STATE_ADS_LOADED             = 3;


// LOCAL FUNCTIONS


/**
 * 
 * createAdContainerDiv
 */
function createAdContainerDiv(ads)
{
    let adsidebar = ads.adsidebar;
    let wnd = adsidebar.wnd;
    let doc = wnd.document;
    
    let adContainerDiv = doc.createElement('div');
    adContainerDiv.id = 'adsidebar_ad_container';
    adContainerDiv.style.overflow = 'auto';
    adContainerDiv.style.height = adsidebar.adBoxHeight * 3 + 'px';

    adsidebar.sidebarDiv.appendChild(adContainerDiv);
    
    ads.adContainerDiv = adContainerDiv;
}


/**
 * startDynamicAdObserver
 * 
 * Detect dynamic ads that are filtered with filter = elemhide.
 * i.e. these ads are not blocked via content policy, so there is no call to processPolicyResponse 
 * which would signal an ad has been dynamically added.
 */
function startDynamicAdObserver(ads)
{
    
    let wnd = ads.adsidebar.wnd;
    let MutationObserver = wnd.MutationObserver || wnd.WebKitMutationObserver || wnd.MozMutationObserver;

    // create an observer instance
    ads.dynamicAdObserver = new MutationObserver(
        function(ads, mutations) {
            
            // find elements that are to be hidden with filter = elemhide
            let hiddenNodeArray = getHiddenElements(ads);
            
            if (hiddenNodeArray.length) {
                
                // move elements to sidebar
                moveNodes(ads, hiddenNodeArray);
            }                
            
            //mutations.forEach(function(mutation) {
            //
            //});
    }.bind(this, ads));
    
    // configuration of the observer:
    let config = { attributes: true, characterData: true, subtree: true };
    
    // pass in the target node, as well as the observer options
    ads.dynamicAdObserver.observe(wnd.document, config);
}

/**
 * stopDynamicAdObserver   
 */
function stopDynamicAdObserver(ads)
{
    
    if (ads.dynamicAdObserver) {
        ads.dynamicAdObserver.disconnect();
    }
}


/**
 * monitorAdLoadingTimeout
 * 
 * NOTE - do not modify DOM in this function
 */
function monitorAdLoadingTimeout(ads)
{
    
    let wnd = ads.adsidebar.wnd;
    let restartTimer = false;

    // wait a maximum of 5 seconds for ads to load
    ads.elapsedAdLoadTime++;
    if (ads.elapsedAdLoadTime <= 5) {
        while (1) {
            // check mutation observer
            let mutations = ads.monitorAdLoadObserver.takeRecords();
            if (mutations.length) {
                ads.dirty = true;
            }
            
            if (ads.dirty) {
                ads.dirty = false;
                restartTimer = true;
                break;
            }

            // check that all iframes are loaded
            let iframesArray = ads.adContainerDiv.getElementsByTagName("iframe");
            for (let i = 0; i < iframesArray.length; i++) {
                
                if (iframesArray[i].contentDocument) {
                    let readyState = iframesArray[i].contentDocument.readyState;
                    if (readyState != "complete") {
                        restartTimer = true;
                        break;
                    }                
                }
            }    
            
            if (restartTimer) {
                break;
            }
                
            // find numNonEmptyAdDivs i.e. possible ad divs
            // (do not modify DOM!)
            findAdDivs(ads);
            
            // even though all iframes are loaded, check to make sure the div is non-empty
            let emptyAdDivsArray = findEmptyAdDivs(ads);
            if (emptyAdDivsArray.length) {
                restartTimer = true; 
                break;
            }

            // refresh GPT if script error did not occur yet ads did not load
            if (!ads.adsidebar.scriptErrorFlag && ads.adsidebar.refreshgpt) {
                // if at least 50% of ads did not load, refresh GPT
                if (ads.stats.numEmptyAdDivs > (ads.stats.numNonEmptyAdDivs / 2)) {
                    
                    // refresh GPT ads if script error occurred
                    if (wnd.wrappedJSObject.googletag) {
                        let pubads = wnd.wrappedJSObject.googletag.pubads;
                        if (pubads) {
                            pubads().refresh();                    
                        }
                    }
                    restartTimer = true;
                    break; 
                }            
                
            }

            // ads finished loading
            break;        
        }
        
    } else {
        
        // find numNonEmptyAdDivs i.e. possible ad divs
        // (do not modify DOM!)
        findAdDivs(ads);
    }
   
    if (restartTimer) {
        // restart timeout            
        ads.timeoutId = wnd.setTimeout( monitorAdLoadingTimeout.bind(this, ads), 1000);
    } else {
        
        ads.elapsedAdLoadTime = 0;
        
        adLoadingComplete(ads);
    }

}

/**
 * startMonitorAdLoading
 */
function startMonitorAdLoading(ads)
{

    let wnd = ads.adsidebar.wnd;
    let MutationObserver = wnd.MutationObserver || wnd.WebKitMutationObserver || wnd.MozMutationObserver;
    
    // create an observer instance
    ads.monitorAdLoadObserver = new MutationObserver(
        function(mutations) {
            ads.dirty = true;
            //mutations.forEach(function(mutation) {
            //
            //});
    });
    
    // configuration of the observer:
    let config = { attributes: true, characterData: true, subtree: true };
    
    // pass in the target node, as well as the observer options
    ads.monitorAdLoadObserver.observe(ads.adContainerDiv, config);
    
    // timer to check ad loading
    ads.timeoutId = wnd.setTimeout( monitorAdLoadingTimeout.bind(this, ads), 1000);
    
    ads.state = ADS_STATE_ADS_LOADING;
    
}

/**
 * stopMonitorAdLoading
 */
function stopMonitorAdLoading(ads)
{
    
    ads.state = ADS_STATE_ADS_LOADED;
    
    ads.adsidebar.wnd.clearTimeout(ads.timeoutId);
    
    ads.monitorAdLoadObserver.disconnect();
}



/**
 * adLoadingComplete
 */
function adLoadingComplete(ads)
{
    let adsidebar = ads.adsidebar;
    let wnd = adsidebar.wnd;
    
    // stop mutation observer - now we can modify the ads style
    stopMonitorAdLoading(ads);
    
    // adjust ads' style if necessary
    stripStylesFromAds(ads);
            
    // style ad dividers
    styleAdDivs(ads);

    // hide unused divs
    hideNonAdDivs(ads);
    
    // hide any unloaded ads
     let emptyAdDivsArray = findEmptyAdDivs(ads);
    hideEmptyAdDivs(ads, emptyAdDivsArray);
    
    // last ad div 
    ads.prevLastAdDiv = ads.lastAdDiv;
    ads.lastAdDiv = findLastAdDiv(ads);
    
    let numAds = ads.stats.numNonEmptyAdDivs - emptyAdDivsArray.length;
    
    if (numAds > ads.stats.numAds) {
        
        ads.stats.numAds = numAds;
        
        if (ads.prevLastAdDiv) {
            // new ads have been dynamically inserted
            
            // create status iframe to show user that new ads have been inserted.
            // insert into ad container div.
            let statusNode = createStatusIframe(ads, ads.prevLastAdDiv);
            
            // scroll new ads into view
            if (statusNode) {
                statusNode.scrollIntoView();
            }
        }
        
        
        // notify adsidebar module that ads have finished loading
        // This will display the adsidebar to the user.
        ads.adsidebar.notifyAdLoadingComplete(ads.adsidebar);
    }

    // some websites modify this. Make sure zIndex is correct.
    ads.adsidebar.sidebarDiv.style.zIndex = 2147483647;
}

/**
 * 
 * moveNodes
 */
function moveNodes(ads, adNodeArray)
{
        
    for (let adnode of adNodeArray) {
        Ads.insertNewNode(ads, adnode);
    } 
}

/**
 * 
 * checkAdSize
 */
function checkAdSize(ads)
{
    
    let restyle = false;
    
    // ad size can change after the page loads.
    // If any ad size has changed, restyle the ad divs
    for (let i = 0; i < ads.adInfoArray.length; i++) {
        let adInfo = ads.adInfoArray[i];
        let adNode = adInfo.adNode;

        // size can change as images are loaded or ads are dynamically added   
        let w = adNode.offsetWidth;
        let h = adNode.offsetHeight;
        
        if ((w != adInfo.width) || (h != adInfo.height)) {
            restyle = true;
            break;
        }
    }
            
    if (restyle) {
        styleAdDivs(ads);
    }
}   

/**
 * 
 * styleAdDivs
 */
function styleAdDivs(ads)
{
    let adsidebar = ads.adsidebar;
    
    // style ad container DIV
    // Note that some ads (e.g. yahoo sponsored ads) are text based and will change
    // width/height to adapt to the container size.
    if (adsidebar.sidebarExpanded) {
        ads.adContainerDiv.style.overflow = 'auto';
        ads.adContainerDiv.style.width = adsidebar.maxWidth + 'px';
        ads.adContainerDiv.style.height = adsidebar.maxHeight + 'px';
    } else {
        ads.adContainerDiv.style.overflow = 'auto';
        ads.adContainerDiv.style.width =  ads.adBoxWidth + 'px';
        ads.adContainerDiv.style.height = ads.adBoxHeight * 3 + 'px';
    }
    
    
    // style ad nodes
    for (let i = 0; i < ads.adInfoArray.length; i++) {
        let scaled = false;
        let adInfo = ads.adInfoArray[i];
        let divNode = adInfo.divNode;
        let adNode = adInfo.adNode;

        // style DIV that wraps the ad
        divNode.className = "adsidebar_ad_div";     // dummy class used to find ad divs
        divNode.style.border = "solid black";
        divNode.style.overflow = "hidden";
        divNode.style.visibility = "visible";
        
        if (adsidebar.sidebarExpanded) {
            // use original ad size
            divNode.style.width = adsidebar.maxWidth + 'px';
            divNode.style.height = adInfo.height + 'px';
            
        } else {
            // confine ad width/height to a particular box size
            let newWidth = ads.adBoxWidth;
            let newHeight= ads.adBoxHeight;
            
            divNode.style.width = newWidth + "px";
            divNode.style.height = newHeight + "px";
        }
        
        // style ad node
        adNode.style.transform = "";  // remove any transformations (scaling/translations)
        adNode.style.cssFloat = "left";
        
        // size can change as images are loaded or ads are dynamically added   
        let w = adNode.offsetWidth;
        let h = adNode.offsetHeight;
        
        // scale ad node (if needed)
        let {Adsidebar} = require("child/adsidebar/adSidebar");
        let  adsidebar_prefs = Adsidebar.adsidebar_prefs;
        
        if (!adsidebar_prefs.adsidebar_adScaling || adsidebar.sidebarExpanded || 
            ((w <= ads.adBoxWidth) && (h <= ads.adBoxHeight))) {
        } else {
            scaled = true;
            
            // transform
            let scale_x = 0.5;
            let scale_y = 0.5;
            
            let translate_x = 0;
            let translate_y = 0;

            if (scale_x < 1) {
                translate_x = -(w - w * scale_x) / 2;
                translate_x = Math.floor(translate_x);
            }
            if (scale_y < 1) {
                translate_y = -(h - h * scale_y) / 2;
                translate_y = Math.floor(translate_y);
            }
            
            // transform is from right to left
            // 1. scale first
            // 2. then translate
            let transform = "translate(" + translate_x + "px, " + translate_y + "px) ";
            transform += "scale(" + scale_x + ", " + scale_y + ") ";

            adNode.style.transform = transform;

        }
        
        // reduce the surrounding div's height
        if (adsidebar.sidebarExpanded) {
            divNode.style.height = adNode.offsetHeight + "px";
        } else {
            let newHeight = scaled ? adNode.offsetHeight * 0.5 : adNode.offsetHeight;
            if (newHeight < ads.adBoxHeight) {
                divNode.style.height = newHeight + "px";
            }
        }
    }        
}

/**
 * 
 * findAdDivs
 */
function findAdDivs(ads)
{
    let numNonEmptyAdDivs = 0;
    let wnd = ads.adsidebar.wnd;

    // empty adInfoArray
    ads.adInfoArray.length = 0;
    
    let childNodeArray = ads.adContainerDiv.childNodes;
    
    for (let i = 0; i < childNodeArray.length; i++) {
        let node = childNodeArray[i].firstChild; //ignore added div that wraps each ad
        
        if (!node) {
            continue;
        }
        
        // check for empty node (i.e. no children)
        if (node.childNodes.length == 0) {
            if (node.nodeName != "IFRAME" && node.nodeName != "IMG") {
                continue;
            }
        }
        
        let w = node.offsetWidth;
        let h = node.offsetHeight;
        
        // ignore auto/auto
        if (isNaN(w) && isNaN(h)) {
            continue;
        }    

        // ignore width/height = 0, negative, or very thin DIVs
        if ((w <= 15) || (h <= 15)) {
            continue;
        }    
        

        numNonEmptyAdDivs++;
        
        let adInfo = {
            divNode : node.parentNode, // points to div that wraps ad
            adNode : node,
            width : w,              // original unscaled width / height (number, not string with px)
            height : h, 
        };
        ads.adInfoArray.push(adInfo);
    }
    
    ads.stats.numNonEmptyAdDivs = numNonEmptyAdDivs;
}

/**
 * 
 * hideNonAdDivs
 */
function hideNonAdDivs(ads)
{
    let wnd = ads.adsidebar.wnd;
    
    let childNodeArray = ads.adContainerDiv.childNodes;
    
    for (let i = 0; i < childNodeArray.length; i++) {
        let node = childNodeArray[i]; 
        
        if (node.className != "adsidebar_ad_div") {
            node.style.display = "none";
           // node.style.visibility = "hidden";   //need div to be hidden, but also have dimensions
        }
    }
}

/**
 * 
 * hideEmptyAdDivs
 */
function hideEmptyAdDivs(ads, emptyAdDivsArray)
{
    
   // hide all empty divs
    for (let i = 0; i < emptyAdDivsArray.length; i++) {
        let node = emptyAdDivsArray[i]; 
        node.style.display = "none";
        // node.style.visibility = "hidden";   //need div to be hidden, but also have dimensions
    }

}


/**
 * 
 * findLastAdDiv
 */
function findLastAdDiv(ads)
{
    
    let childNodeArray = ads.adContainerDiv.childNodes;
    let last = null;
    
    for (let i = 0; i < childNodeArray.length; i++) {
        let node = childNodeArray[i]; 
        
        if ((node.className == "adsidebar_ad_div") && (node.style.display != "none")) {
            last = node;
        }    
    }
    
    return last;
}

/**
 * 
 * findEmptyAdDivs
 * 
 * - find ad divs that did not load.  
 */
function findEmptyAdDivs(ads)
{
    let wnd = ads.adsidebar.wnd;
    let emptyAdDivsArray = [];

    function checkEmptyIframe(node) 
    {
        let empty = true;
        
        let iframeArray = node.querySelectorAll("iframe");
        for (let j = 0; j < iframeArray.length; j++) {
            let iframeNode = iframeArray[j];
            
            if (iframeNode && iframeNode.contentDocument && iframeNode.contentDocument.body) {
                let w = iframeNode.contentDocument.body.offsetWidth;
                let h = iframeNode.contentDocument.body.offsetHeight;
                
                //  auto/auto => empty
                if (isNaN(w) && isNaN(h)) {
                    continue;
                }    

                //  width/height = 0, negative, or very thin DIVs => empty
                if ((w <= 15) && (h <= 15)) {
                    continue;
                }    
                
                empty = false;
                break;
            }
        }
        
        empty = empty && iframeArray.length;
        
        if (empty) {
            
            // display debug info
           for (let j = 0; j < iframeArray.length; j++) {
                let iframeNode = iframeArray[j];
                if (iframeNode && iframeNode.contentDocument && iframeNode.contentDocument.body) {
                    let w = iframeNode.contentDocument.body.offsetWidth;
                    let h = iframeNode.contentDocument.body.offsetHeight;
                }   
               
           }        
        }
        return empty;        
    }

    function checkEmptyDiv(node) 
    {
        let iframeArray = node.querySelectorAll("iframe");
        if (iframeArray.length) {
            return false;
        }

        let iImgArray = node.querySelectorAll("img");
        if (iImgArray.length) {
            return false;
        }
    
        if (node.innerText != "") {
            return false;
        }
        
        
        return true;
    }
    
    // find empty divs
    
    for (let i = 0; i < ads.adInfoArray.length; i++) {
        let node = ads.adInfoArray[i].divNode; 
            
        // find iframes and check the document body size
        if (checkEmptyIframe(node)) {   
            emptyAdDivsArray.push(node);
            continue;
        }

        // check for divs with non-zero dimensions, but empty otherwise (i.e. divs nested in divs)
        if (checkEmptyDiv(node)) {   
            emptyAdDivsArray.push(node);
        }
    }   
    ads.stats.numEmptyAdDivs = emptyAdDivsArray.length;
    
    return emptyAdDivsArray;
    
}

/**
 * 
 * stripStylesFromAds
 * 
 * - remove styles such as "position:absolute" from ads  
 */
function stripStylesFromAds(ads)
{
    let wnd = ads.adsidebar.wnd;

    let childNodeArray = ads.adContainerDiv.childNodes;
    
    for (let i = 0; i < childNodeArray.length; i++) {
        let node = childNodeArray[i]; 
        
        // find all iframes - make sure position is not absolute
        let iframeArray = node.querySelectorAll("iframe");
        for (let j = 0; j < iframeArray.length; j++) {
            let iframeNode = iframeArray[j];
            iframeNode.style.position = "";
        }                
    }                
}



/**
 * getHiddenElements
 */
function getHiddenElements(ads)
{
    let wnd = ads.adsidebar.wnd;
    let doc = wnd.document;
    let adNodeArray = [];
    let resultNodeArray = [];
    
    for (let hit of ads.adsidebar.hits)
    {   
        //
        
        if (hit.filterType == "elemhide") {
            let index = hit.filter.indexOf("##");
            let selector = hit.filter.substr(index + 2);
            
            //
            
            let nodeList = doc.querySelectorAll(selector); 
            let nodeArray = Array.from(nodeList); 
            
            for (let node of nodeArray) {
                // ignore node if it already exists in the ad container div
                if (!ads.adContainerDiv || (ads.adContainerDiv && !ads.adContainerDiv.contains(node))) {
                    let style = wnd.getComputedStyle(node, null);
                    //
                    
                    adNodeArray.push(node);
                }
            }
        }
    }
    
    // eliminate any nodes that are descendants of other nodes
    for (let node of adNodeArray) {
        let isDescendant = false;

        for (let tempNode of adNodeArray) {
            if (tempNode != node && tempNode.contains(node)) {
                isDescendant = true;
            }
        }
        
        if (!isDescendant) {
            
            resultNodeArray.push(node);
            
            //let style = wnd.getComputedStyle(node, null);
            //
        }
    }
    
    ads.stats.numHiddenElements += resultNodeArray.length;
    
    return resultNodeArray;
}


/**
 * createStatusIframe
 * 
 * Create iframe which displays status to the user
 * Used to dynamically insert status when webpages dynamically loads ads (e.g. yahoo, facebook)
 */
function createStatusIframe(ads, prevLastAdDiv)
{
    
    let wnd = ads.adsidebar.wnd;
    let doc = wnd.document;

    
    // add status
    let request = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Components.interfaces.nsIXMLHttpRequest);
                        
    request.open("GET", "resource://adsidebar/adsidebar_status.html", false );
    request.send();
    
    if (request.responseText) {
        let statusIFrame = doc.createElement('iframe');        // on iframe load, add event listners to buttons
        
        statusIFrame.addEventListener("load", 
            function() {
                // style iframe
                //statusIFrame.width = ads.adBoxWidth + "px";
                statusIFrame.height = statusIFrame.contentDocument.body.clientHeight + "px";
                statusIFrame.style.margin = "0px";
                statusIFrame.style.border = "0px";
                //statusIFrame.style.width = adsidebar.ads.adBoxWidth + "px";
                statusIFrame.style.height = statusIFrame.contentDocument.body.clientHeight + "px";

                // style iframe.document                    
                statusIFrame.contentDocument.body.style.overflow = "hidden";
                
            }.bind(this), false);

        
        
        statusIFrame.srcdoc = request.responseText;

        // append status iframe to ad container DIV after the previous last ad div.
        ads.adContainerDiv.insertBefore(statusIFrame, prevLastAdDiv.nextSibling);
        
        return statusIFrame;
    }
    
    return null;
}


// EXPORTED FUNCTIONS

let Ads = exports.Ads=
{
    /**
     * 
     * windowInit
     */
    windowInit : function (adsidebar)
    {
        // create ads object
        adsidebar.ads = {
            adsidebar : adsidebar,    
            state   : ADS_STATE_INIT,  
            adContainerDiv : null,     // div that holds all ads 
            adBoxWidth : 200,          // ad box size
            adBoxHeight : 200,
            adInfoArray : [],          // array of all ads found
            
            elapsedAdLoadTime : 0,      // seconds 
            monitorAdLoadObserver : null, 
            dynamicAdObserver : null,
            dirty : true,
            timeoutId : null,
            prevLastAdDiv : null,
            lastAdDiv: null,
            stats : {
                numHiddenElements : 0,
                numNonEmptyAdDivs : 0,        // ad divs
                numEmptyAdDivs : 0,
                numAds : 0,
            }    
        };
    },
    
    /**
     * 
     * windowLoad
     */
    windowLoad : function (ads)
    {
        ads.state = ADS_STATE_WINDOW_LOADED;
        
        // create ad container DIV
        createAdContainerDiv(ads);

        // mutation observer to detect dynamic ads (ads loaded after the page is loaded)
        // This detect ads hidden using CSS (filter=elemHide). These nodes won't be detected via
        // content policy.
        startDynamicAdObserver(ads);

        // find elements that are to be hidden with filter = elemhide
        let hiddenNodeArray = getHiddenElements(ads);
        
        // move elements to sidebar
        moveNodes(ads, hiddenNodeArray);
    },    

    /**
     * 
     * windowUnload
     */
    windowUnload : function (ads)
    {
        stopDynamicAdObserver(ads);
    },    

    /**
     * 
     * insertNewNode
     */
    insertNewNode : function (ads, node)
    {
        
        let wnd = ads.adsidebar.wnd;
        
        // start ad monitoring if page has loaded
        if (ads.state >= ADS_STATE_WINDOW_LOADED) {
            if (ads.state != ADS_STATE_ADS_LOADING) {
                // start ad loading monitor
                startMonitorAdLoading(ads);
                
            } else {
                // ad monitor already started -  reset ad loading monitor timeout
                if (ads.timeoutId) {
                    wnd.clearTimeout(ads.timeoutId);
                    ads.timeoutId = wnd.setTimeout( monitorAdLoadingTimeout.bind(this, ads), 1000);
                }
            }
        }
        
        // insert node into ad container DIV
        // create DIV to hold the ad. This will be styled after the ad loads.
        let adDiv = ads.adsidebar.wnd.document.createElement('div');

        // insert DIV into ad container
        ads.adContainerDiv.appendChild(adDiv);
        
        // remove node from original page location
        if (node.parentElement) {
            node.parentElement.removeChild(node);
        }
        
        // insert ad node into ad DIV
        adDiv.appendChild(node);
    },    

    /**
     * insertNewNodeDynamic
     *   - called when ad resources are attempted to be loaded after the page is loaded
     */
    insertNewNodeDynamic : function(ads, node, hits)
    {
        let adsidebar = ads.adsidebar;
        
        // dynamic ads - add filter = elemhide
        let elemHide = false;
        for (let hit of hits)
        {   
            if (hit.filterType == "elemhide") {
                elemHide = true;
            }
        }
        
        if (elemHide) {
            adsidebar.hits = adsidebar.hits.concat(hits);
            
            // find elements that are to be hidden with filter = elemhide
            let hiddenNodeArray = getHiddenElements(ads);
            
            if (hiddenNodeArray.length) {
                
                // move elements to sidebar
                moveNodes(ads, hiddenNodeArray);
            }                
        } else {
            // filterType == "blocking"
            
            if (node.nodeName != "SCRIPT")  {
                
                if (node.ownerDocument == adsidebar.wnd.document) {
                    let inSidebar = adsidebar.sidebarDiv.contains(node);
                    if (inSidebar) {
                    } else {
                        
                        // insert node into ad container DIV
                        this.insertNewNode(ads, node);
                    }
                }
                
            }
        }
        
    },
    
    /**
     * notifySidebarExpanded
     */
    notifySidebarExpanded : function(ads)
    {
        // style ad dividers
        styleAdDivs(ads);
        
    },
        
    /**
     * notifySidebarCollapsed
     */
    notifySidebarCollapsed : function(ads)
    {
        // style ad dividers
        styleAdDivs(ads);
    },

}

