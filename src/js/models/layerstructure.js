/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports, module) {
    "use strict";

    var Immutable = require("immutable");

    var Layer = require("./layer"),
        LayerNode = require("./layernode"),
        Bounds = require("./bounds"),
        Radii = require("./radii"),
        Stroke = require("./stroke"),
        Fill = require("./fill");

    var objUtil = require("js/util/object"),
        log = require("js/util/log");

    /**
     * A model of the Photoshop layer structure.
     * 
     * @constructor
     */
    var LayerStructure = Immutable.Record({
        /**
         * All Layer objects indexed by layer ID.
         *
         * @type {Immutable.Map.<number, Layer>}
         */
        layers: null,

        /**
         * Index-ordered layer IDs.
         *
         * @type {Immutable.List.<number>}
         */
        index: null,

        /**
         * Mapping from layer IDs to indices.
         *
         * @type {Immutable.Map.<number, number>}
         */
        reverseIndex: null,

        /**
         * All LayerNode objects index by layer ID.
         *
         * @type {Immutable.Map.<number, LayerNode>}
         */
        nodes: null,

        /**
         * Index-ordered root LayerNode objects.
         * 
         * @type {Immutable.List.<LayerNode>}
         */
        roots: null
    });

    /**
     * From a layer index (an ordered sequence of Layers), create a reverse index,
     * mapping each Layer's ID to its index.
     * 
     * @param {Immutable.List.<Layer>} index
     * @return {Immutable.Map.<number, number>}
     */
    var _makeReverseIndex = function (index) {
        var reverseIndex = index.reduce(function (reverseIndex, layerID, index) {
            return reverseIndex.set(layerID, index + 1);
        }, new Map());

        return Immutable.Map(reverseIndex);
    };

    /**
     * Construct a LayerStructure model from Photoshop document and layer descriptors.
     * 
     * @param {object} documentDescriptor
     * @param {object} layerDescriptors
     * @return {LayerStructure}
     */
    LayerStructure.fromDescriptors = function (documentDescriptor, layerDescriptors) {
        var targetLayers = documentDescriptor.targetLayers || [],
            selectedIndices = targetLayers.reduce(function (indices, obj) {
                indices[obj.index + 1] = true;
                return indices;
            }, {});

        var layers = layerDescriptors.reduce(function (layers, layerDescriptor) {
            var layerID = layerDescriptor.layerID,
                itemIndex = layerDescriptor.itemIndex,
                selected = selectedIndices[itemIndex];

            layers.set(layerID, Layer.fromDescriptor(documentDescriptor, layerDescriptor, selected));
            return layers;
        }, new Map());
        layers = Immutable.Map(layers);

        var index = layerDescriptors.reverse().map(function (layerDescriptor) {
            return layerDescriptor.layerID;
        });
        index = Immutable.List(index);

        var reverseIndex = _makeReverseIndex(index);

        var layerList = index.map(function (layerID) {
            return layers.get(layerID);
        });

        var nodeInfo = LayerNode.fromLayers(layerList),
            roots = nodeInfo.roots,
            nodes = nodeInfo.nodes;

        return new LayerStructure({
            layers: layers,
            index: index,
            reverseIndex: reverseIndex,
            nodes: nodes,
            roots: roots
        });
    };

    /**
     * Helper function for getSelectableLayers
     * For one layer, adds all siblings of it's parents, all the way up the tree
     * 
     * @private
     * @param {Layer} layer Starting layer
     * @param {Immutable.Iterable.<Layer>} selectableLayers Collection of selectable layers so far 
     * @param {Object.<{number: Layer}>} visitedParents Already processed parents
     * @return {Immutable.Iterable.<Layer>} Siblings of this layer
     */
    LayerStructure.prototype._replaceAncestorWithSiblingsOf = function (layer, selectableLayers, visitedParents) {
        var layerAncestor = this.parent(layer);

        // If we were already at root, we don't need to do anything for this layer
        if (!layerAncestor) {
            return selectableLayers;
        }

        var pull = function (layers, parent) {
            return layers.filter(function (layer) {
                return layer !== parent;
            });
        };
            
        // Traverse up to root
        while (layerAncestor && !visitedParents.hasOwnProperty(layerAncestor.id)) {
            // Remove the current parent because we're already below it
            selectableLayers = pull(selectableLayers, parent);

            // So we don't process this parent again
            visitedParents[layerAncestor.id] = layerAncestor;
            
            // Add the siblings of this layer to accepted layers
            selectableLayers = selectableLayers.concat(this.children(layerAncestor));
        
            layerAncestor = this.parent(layerAncestor);
        }

        return selectableLayers;
    };

    Object.defineProperties(LayerStructure.prototype, objUtil.cachedGetSpecs({
        /**
         * Index-ordered list of all layer models.
         * @type {Immutable.List.<Layer>}
         */
        "all": function () {
            return this.index.map(this.byID, this);
        },
        /**
         * Root Layer models of the layer forest.
         * @type {Immutable.List.<Layer>}
         */
        "top": function () {
            return this.roots
                .map(function (node) {
                    return this.byID(node.id);
                }, this)
                .filter(function (layer) {
                    return layer.kind !== layer.layerKinds.GROUPEND;
                });
        },
        /**
         * The subset of Layer models that correspond to currently selected layers.
         * @type {Immutable.List.<Layer>}
         */
        "selected": function () {
            return this.all.filter(function (layer) {
                return layer.selected;
            }, this);
        },
        /**
         * Child-encompassing bounds objects for all the selected layers.
         * @type {Immutable.List.<Bounds>}
         */
        "selectedChildBounds": function () {
            return this.selected
                .map(function (layer) {
                    return this.childBounds(layer);
                }, this)
                .filter(function (bounds) {
                    return bounds;
                });
        },
        /**
         * The number of layers in the layer forest.
         * @type {number}
         */
        "size": function () {
            return this.layers.size;
        },
        /**
         * The subset of Layer models that correspond to leaves of the layer forest.
         * @type {Immutable.List.<Layer>}
         */
        "leaves": function () {
            return this.all.filter(function (layer) {
                return layer.kind !== layer.layerKinds.GROUPEND &&
                    layer.kind !== layer.layerKinds.GROUP &&
                    layer.visible &&
                    !this.hasLockedAncestor(layer);
            }, this);
        },
        /**
         * The subset of Layer models that can currently be directly selected.
         * @type {Immutable.List.<Layer>}
         */
        "selectable": function () {
            var visitedParents = {};

            return this.selected
                .reduce(function (validLayers, layer) {
                    return this._replaceAncestorWithSiblingsOf(layer, validLayers, visitedParents);
                }, this.top, this)
                .filter(function (layer) {
                    return layer.kind !== layer.layerKinds.GROUPEND &&
                        layer.visible &&
                        !this.hasLockedAncestor(layer) &&
                        !visitedParents.hasOwnProperty(layer.id);
                }, this);
        },
        /**
         * Determine if selected layers are "locked"
         * Currently true for any of the following:
         * 1) The background layer is selected
         * 2) Any selected layers are locked
         * 3) No layers are selected
         * 
         * @type {boolean} If any selected layers are locked, or if none are selected
         */
        "selectedLocked": function () {
            var selectedLayers = this.selected;
            return selectedLayers.size === 0 || selectedLayers.some(function (layer) {
                return layer.isBackground || layer.locked;
            });
        }
    }));

    /**
     * Get a Layer model by layer ID.
     *
     * @param {number} id
     * @return {?Layer}
     */
    LayerStructure.prototype.byID = function (id) {
        return this.layers.get(id, null);
    };

    /**
     * Get a Layer model by layer index.
     *
     * @param {number} index
     * @return {?Layer}
     */
    LayerStructure.prototype.byIndex = function (index) {
        var layerID = this.index.get(index - 1, null);
        if (layerID === null) {
            return null;
        } else {
            return this.byID(layerID);
        }
    };

    /**
     * Find the index of the given layer.
     * 
     * @param {Layer} layer
     * @return {?number}
     */
    LayerStructure.prototype.indexOf = function (layer) {
        return this.reverseIndex.get(layer.id, null);
    };

    /**
     * Find the parent of the given layer.
     * 
     * @param {Layer} layer
     * @return {?Layer}
     */
    LayerStructure.prototype.parent = function (layer) {
        var node = this.nodes.get(layer.id, null);

        if (!node || node.parent === null) {
            return null;
        } else {
            return this.byID(node.parent);
        }
    };

    /**
     * Find the children of the given layer.
     * 
     * @param {Layer} layer
     * @return {?Immutable.List.<Layer>}
     */
    Object.defineProperty(LayerStructure.prototype, "children", objUtil.cachedLookupSpec(function (layer) {
        var node = this.nodes.get(layer.id, null);

        if (node && node.children) {
            return node.children.map(function (child) {
                return this.byID(child.id);
            }, this);
        } else {
            return Immutable.List();
        }
    }));

    /**
     * Find all siblings of the given layer, including itself.
     *
     * @param {Layer} layer
     * @return {Immutable.List.<Layer>}
     */
    Object.defineProperty(LayerStructure.prototype, "siblings", objUtil.cachedLookupSpec(function (layer) {
        var parent = this.parent(layer);

        if (parent) {
            var children = this.children(parent);
            return children.map(function (child) {
                return this.byID(child.id);
            }, this);
        } else {
            return this.top;
        }
    }));

    /**
     * Find all ancestors of the given layer, including itself.
     *
     * @param {Layer} layer
     * @return {?Immutable.List.<Layer>}
     */
    Object.defineProperty(LayerStructure.prototype, "ancestors", objUtil.cachedLookupSpec(function (layer) {
        var node = this.nodes.get(layer.id, null),
            parent = node && this.byID(node.parent);

        if (parent) {
            return this.ancestors(parent).push(layer);
        } else {
            return Immutable.List.of(layer);
        }
    }));

    /**
     * Find all descendants of the given layer, including itself.
     *
     * @param {Layer} layer
     * @return {Immutable.List.<Layer>}
     */
    Object.defineProperty(LayerStructure.prototype, "descendants", objUtil.cachedLookupSpec(function (layer) {
        return this.children(layer)
            .map(this.descendants, this)
            .flatten(true)
            .push(layer);
    }));

    /**
     * Determine whether some ancestors of the given laye rare locked.
     * 
     * @param {Layer} layer
     * @return {boolean}
     */
    Object.defineProperty(LayerStructure.prototype, "hasLockedAncestor", objUtil.cachedLookupSpec(function (layer) {
        return this.ancestors(layer).some(function (ancestor) {
            return ancestor.locked;
        }, this);
    }));

    /**
     * Calculate the child-encompassing bounds of the given layer. Returns null
     * for end-group layers and otherwise-empty groups.
     * 
     * @param {Layer} layer
     * @return {?Bounds}
     */
    Object.defineProperty(LayerStructure.prototype, "childBounds", objUtil.cachedLookupSpec(function (layer) {
        if (layer.kind === layer.layerKinds.GROUPEND) {
            return null;
        }
        
        var childBounds = this.descendants(layer)
            .filter(function (layer) {
                switch (layer.kind) {
                case layer.layerKinds.GROUP:
                case layer.layerKinds.GROUPEND:
                    return false;
                default:
                    return true;
                }
            })
            .map(function (layer) {
                return layer.bounds;
            });

        return Bounds.union(childBounds);
    }));

    /**
     * Reset the given layer from a Photoshop layer descriptor.
     * 
     * @param {number} layerID
     * @param {object} descriptor
     * @param {Document} previousDocument
     * @return {LayerStructure}
     */
    LayerStructure.prototype.resetLayer = function (layerID, descriptor, previousDocument) {
        var layer = this.byID(layerID),
            nextLayer = layer.resetFromDescriptor(descriptor, previousDocument),
            nextLayers = this.layers.set(layerID, nextLayer);

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    /**
     * Update basic properties of the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {object} properties
     * @return {LayerStructure}
     */
    LayerStructure.prototype.setProperties = function (layerIDs, properties) {
        var nextProperties = Immutable.Map(properties),
            updatedLayers = Immutable.Map(layerIDs.reduce(function (layers, layerID) {
                layers.set(layerID, nextProperties);
                return layers;
            }.bind(this), new Map()));

        return this.mergeDeep({
            layers: updatedLayers
        });
    };

    /**
     * Update the bounds of the given layers. 
     * 
     * @private
     * @param {Immutable.Map.<number, Bounds>} allBounds The keys of the Map are layer IDs.
     * @return {LayerStructure}
     */
    LayerStructure.prototype._updateBounds = function (allBounds) {
        var nextBounds = allBounds.map(function (bounds) {
            return Immutable.Map({
                bounds: bounds
            });
        });

        return this.mergeDeep({
            layers: nextBounds
        });
    };

    /**
     * Resize the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {number=} w
     * @param {number=} h
     * @return {LayerStructure}
     */
    LayerStructure.prototype.resizeLayers = function (layerIDs, w, h) {
        var allBounds = Immutable.Map(layerIDs.reduce(function (allBounds, layerID) {
            var layer = this.byID(layerID);
            if (layer.bounds) {
                allBounds.set(layerID, layer.bounds.updateSize(w, h));
            }

            return allBounds;
        }.bind(this), new Map()));

        return this._updateBounds(allBounds);
    };

    /**
     * Translate the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {number=} x
     * @param {number=} y
     * @return {LayerStructure}
     */
    LayerStructure.prototype.translateLayers = function (layerIDs, x, y) {
        var allBounds = Immutable.Map(layerIDs.reduce(function (allBounds, layerID) {
            var layer = this.byID(layerID);
            if (layer.bounds) {
                allBounds.set(layerID, layer.bounds.updatePosition(x, y));
            }

            return allBounds;
        }.bind(this), new Map()));

        return this._updateBounds(allBounds);
    };

    /**
     * Update the selection property to be select iff the layer ID is contained
     * in the given set.
     * 
     * @param {Immutable.Set.<number>} selectedIDs
     * @return {LayerStructure}
     */
    LayerStructure.prototype.updateSelection = function (selectedIDs) {
        var updatedLayers = this.layers.map(function (layer) {
            var selected = selectedIDs.has(layer.id);
            return layer.set("selected", selected);
        });

        return this.set("layers", updatedLayers);
    };

    /**
     * Reorder the layers in the given order.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @return {LayerStructure}
     */
    LayerStructure.prototype.updateOrder = function (layerIDs) {
        var updatedIndex = Immutable.List(layerIDs).reverse(),
            updatedReverseIndex = _makeReverseIndex(updatedIndex),
            layerList = updatedIndex.map(this.byID, this),
            updatedNodeInfo = LayerNode.fromLayers(layerList),
            updatedNodes = updatedNodeInfo.nodes,
            updatedRoots = updatedNodeInfo.roots;

        return this.merge({
            index: updatedIndex,
            reverseIndex: updatedReverseIndex,
            nodes: updatedNodes,
            roots: updatedRoots
        });
    };

    /**
     * Set the border radii of the given layers.
     * 
     * @param {Immutable.Iteralble.<number>} layerIDs
     * @param {Radii} radii
     * @return {LayerStructure}
     */
    LayerStructure.prototype.setBorderRadii = function (layerIDs, radii) {
        var nextRadii = new Radii(radii),
            nextLayers = Immutable.Map(layerIDs.reduce(function (map, layerID) {
                return map.set(layerID, Immutable.Map({
                    radii: nextRadii
                }));
            }, new Map()));

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    /**
     * Set basic properties of the fill at the given index of the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {number} fillIndex
     * @param {object} fillProperties
     * @return {LayerStructure}
     */
    LayerStructure.prototype.setFillProperties = function (layerIDs, fillIndex, fillProperties) {
        var nextLayers = Immutable.Map(layerIDs.reduce(function (map, layerID) {
            var layer = this.byID(layerID),
                fill = layer.fills.get(fillIndex);

            if (!fill) {
                throw new Error("Unable to set fill properties: no fill at index " + fillIndex);
            }

            var nextFill = fill.setFillProperties(fillProperties),
                nextLayer = layer.setIn(["fills", fillIndex], nextFill);

            return map.set(layerID, nextLayer);
        }, new Map(), this));

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    /**
     * Add a new fill, described by a Photoshop "set" descriptor, to the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {object} setDescriptor
     * @return {LayerStructure}
     */
    LayerStructure.prototype.addFill = function (layerIDs, setDescriptor) {
        var nextFill = Fill.fromSetDescriptor(setDescriptor),
            nextLayers = Immutable.Map(layerIDs.reduce(function (map, layerID) {
                // FIXME: If we add a fill to a layer that already has one,
                // is the new fill necessarily appended?
                var layer = this.byID(layerID),
                    nextFills = layer.fills ?
                        layer.fills.push(nextFill) :
                        Immutable.List.of(nextFill);

                return map.set(layerID, Immutable.Map({
                    fills: nextFills
                }));
            }, new Map(), this));

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    /**
     * Set basic properties of the stroke at the given index of the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {number} strokeIndex
     * @param {object} strokeProperties
     * @return {LayerStructure}
     */
    LayerStructure.prototype.setStrokeProperties = function (layerIDs, strokeIndex, strokeProperties) {
        var nextLayers = Immutable.Map(layerIDs.reduce(function (map, layerID) {
            var layer = this.byID(layerID),
                stroke = layer.strokes.get(strokeIndex);

            if (!stroke) {
                throw new Error("Unable to set stroke properties: no stroke at index " + strokeIndex);
            }

            var nextStroke = stroke.setStrokeProperties(strokeProperties),
                nextLayer = layer.setIn(["strokes", strokeIndex], nextStroke);

            return map.set(layerID, nextLayer);
        }, new Map(), this));

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    /**
     * Add a new stroke, described by a Photoshop descriptor, to the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {number} strokeIndex
     * @param {object} strokeStyleDescriptor
     * @return {LayerStructure}
     */
    LayerStructure.prototype.addStroke = function (layerIDs, strokeIndex, strokeStyleDescriptor) {
        var nextStroke = Stroke.fromStrokeStyleDescriptor(strokeStyleDescriptor),
            nextLayers = Immutable.Map(layerIDs.reduce(function (map, layerID) {
                var layer = this.byID(layerID),
                    nextStrokes = layer.strokes ?
                        layer.strokes.set(strokeIndex, nextStroke) :
                        Immutable.List.of(nextStroke);

                return map.set(layerID, Immutable.Map({
                    strokes: nextStrokes
                }));
            }, new Map(), this));

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    /**
     * Set basic properties of the text style at the given index of the given layers.
     * 
     * @param {Immutable.Iterable.<number>} layerIDs
     * @param {object} properties
     * @return {LayerStructure}
     */
    LayerStructure.prototype.setTextStyleProperties = function (layerIDs, properties) {
        var nextLayers = Immutable.Map(layerIDs.reduce(function (map, layerID) {
            var layer = this.byID(layerID),
                textStyles = layer.textStyles;

            if (textStyles.size === 0) {
                throw new Error("Unable to set text style properties: no text styles");
            }

            if (textStyles.size > 1) {
                log.warn("Multiple text styles are unsupported. Reverting to a single style.");
                textStyles = textStyles.slice(0, 1);
            }

            var nextTextStyles = textStyles.map(function (textStyle) {
                return textStyle.merge(properties);
            });

            return map.set(layerID, Immutable.Map({
                textStyles: nextTextStyles
            }));
        }, new Map(), this));

        return this.mergeDeep({
            layers: nextLayers
        });
    };

    module.exports = LayerStructure;
});
