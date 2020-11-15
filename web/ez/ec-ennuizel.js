/*
 * Copyright (c) 2019-2020 Yahweasel 
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

var Ennuizel = (function(ez) {
    var l, threads;

    /* Use half as many threads as we have available, to sort of play nice with
     * the rest of the system, but no more than 8, to play nice with the server */
    if (navigator.hardwareConcurrency) {
        threads = Math.ceil(navigator.hardwareConcurrency/2);
        if (threads > 8) threads = 8;
    } else {
        threads = 1;
    }

    if (!ez.plugins) ez.plugins = [];

    // Some info we can get before Ennuizel starts
    var url = new URL(window.location);
    var params = new URLSearchParams(url.search);
    var idS = params.get("i");
    var id = Number.parseInt(idS, 36);
    var keyS = params.get("k");
    var key = Number.parseInt(keyS, 36);
    var projName = params.get("nm");
    if (!projName) projName = idS;
    var wizardOptsS = params.get("w");
    var wizardOpts = Number.parseInt(wizardOptsS, 36);
    var lang = params.get("lang");
    if (lang !== null) ez.lang = lang;
    var pthreads = params.get("threads");
    if (pthreads !== null) threads = +pthreads;

    // Set to true if we've been asked to use the wizard automatically
    var autoWizard = false;

    // Our supported formats, as a subset of the export formats, named by codec
    var formats = ["flac", "aac", "libvorbis", "libopus", "wavpack", "pcm_s16le", "alac"];

    // We don't want the ID and key to actually be in the URL
    url.search = "";
    window.history.pushState({}, "Ennuizel", url.toString());

    // Once we have the JSON, the info
    var info = null;

    // The track numbers to request
    var tracks = [];

    // Has there been a catastrophic error?
    var error = false;

    // The current track serial number
    var curTrackNo = null;

    function reportError(err) {
        if (err instanceof Error) {
            err = err + "\n\n" + err.stack;
        } else if (typeof err === "object") {
            try {
                err = JSON.stringify(err);
            } catch (ex) {}
        }
        alert(err);
        return Promise.all([]);
    }

    // At startup, just choose our mode
    function start() {
        libav = ez.libav;
        l = ez.l;

        // Create our wizard before anything else
        wizardAdd();

        // Validate
        if (idS === null) {
            // No ID, just go to Ennuizel
            return Promise.resolve(true);
        }

        // Get our wizard options, one way or another
        wizardConvertOpts();

        if (wizardOptsS === null || wizardOpts.ask) {
            // None were provided, or we were asked to ask, so ask
            return mainMode().then(function(mode) {
                if (mode === "wizard") {
                    autoWizard = true;
                    return wizardDialog().then(function(opts) {
                        if (opts)
                            wizardOpts = opts;
                        else
                            autoWizard = false;
                        ez.skipRendering = autoWizard;
                        return downloader();
                    });
                } else if (mode === "downloader") {
                    return downloader();
                } else {
                    return true;
                }
            });

        } else {
            // Don't need to ask for opts
            return mainMode().then(function(mode) {
                if (mode === "wizard") {
                    autoWizard = true;
                    ez.skipRendering = true;
                    return downloader();
                } else if (mode === "downloader") {
                    return downloader();
                } else {
                    return true;
                }
            });

        }
    }
    ez.plugins.push(start);

    // In our "main" mode, we ask whether to use the wizard or not, or just bail out entirely
    function mainMode() {
        return ez.modalWait().then(function(unlock) {
            ez.modalDialog.innerHTML = "";

            ez.mke(ez.modalDialog, "div", {text: l("wizarddesc") + "\n\n"});
            var cancel = ez.mke(ez.modalDialog, "button", {text: l("cancel")});
            ez.mke(ez.modalDialog, "span", {text: "  "});
            var edit = ez.mke(ez.modalDialog, "button", {text: l("edit")});
            ez.mke(ez.modalDialog, "span", {text: "  "});
            var auto = ez.mke(ez.modalDialog, "button", {text: l("auto")});

            ez.modalToggle(true);
            auto.focus();

            return new Promise(function(res, rej) {
                cancel.onclick = function() {
                    unlock();
                    res("cancel");
                };
                edit.onclick = function() {
                    unlock();
                    res("downloader");
                };
                auto.onclick = function() {
                    unlock();
                    res("wizard");
                };
            });

        }).then(function(mode) {
            ez.modal(l("loadinge"));
            if (mode === "downloader")
                return ez.warn(l("postedit")).then(function() { return mode; });
            return mode;

        }).catch(reportError);
    }

    function downloader() {
        var pid = "ec-" + id.toString(36);

        // Find the project ID
        return ez.startup(false).then(function() {
            return ez.dbGlobal.getItem("projects");
        }).then(function(projects) {
            projects = projects || [];
            if (projects.includes(pid)) {
                if (autoWizard) {
                    /* If they're using the wizard in auto mode, they clearly
                     * want to delete anything that's already there */
                    return "delete";
                }

                // They've already imported this!
                return ez.modalWait().then(function(unlock) {
                    ez.modalDialog.innerHTML = "";
                    ez.mke(ez.modalDialog, "div", {text: l("projectexists") + "\n\n"});
                    var load = ez.mke(ez.modalDialog, "button", {text: l("loadexisting")});
                    ez.mke(ez.modalDialog, "span", {text: "  "});
                    var del = ez.mke(ez.modalDialog, "button", {text: l("deleteexisting")});
                    ez.modalToggle(true);
                    load.focus();

                    return new Promise(function(res) {
                        load.onclick = function() {
                            unlock();
                            res("load");
                        };
                        del.onclick = function() {
                            unlock();
                            res("delete");
                        };
                    });
                });
            }

            return "new";

        }).then(function(action) {
            if (action === "load") {
                // Bail out, just load the existing project
                ez.projectName = pid;
                return ez.loadProject().then(function() { return false; });
            }

            if (action === "delete") {
                // Delete the existing project and start fresh
                ez.projectName = pid;
                ez.modal(l("deletinge"));
                return ez.loadProject().then(function() {
                    ez.modal(l("deletinge"));
                    return ez.deleteProject();
                }).then(function() {
                    ez.projectName = pid;
                    return ez.createProject().then(begin);
                });
            }

            // Otherwise, we're just creating the project and starting the download
            ez.projectName = pid;
            return ez.createProject().then(begin);

        });
    }

    // Perform our initial connection
    function begin() {
        // Start by downloading the info
        ez.modal(l("loadinge"));

        return fetch("/panel/rec/dl/?i=" + id.toString(36) + "&f=info").then(function(res) {
            return res.text();

        }).then(function(res) {
            info = JSON.parse(res);

            // Count the tracks
            var length = 1;
            while (info.tracks[length]) {
                tracks.push(length);
                length++;
            }

            // Now start our actual downloads
            doDownloads();

            return false;

        }).catch(function(err) {
            // At this level, just make sure we clean up
            return ez.deleteProject().then(function() {
                throw err;
            });
        });
    }

    // Manage all of our downloaders
    function doDownloads() {
        var downloaders = [], downloaded = [];
        var i, j;
        for (i = 0; i < threads; i++) downloaders.push(null);
        for (i = 0; i < tracks.length; i++) downloaded.push(false);

        function mainLoop() {
            // Activate any inactive threads
            var allInactive = true;
            for (i = 0; i < threads; i++) {
                if (downloaders[i] === null) {
                    // Find an undownloaded track
                    for (j = 0; j < tracks.length; j++)
                        if (!downloaded[j]) break;
                    if (j !== tracks.length) {
                        downloaders[i] = doDownload(i, j);
                        downloaded[j] = true;
                        allInactive = false;
                    }
                } else allInactive = false;
            }

            if (allInactive) {
                // We're done!
                var p = ez.updateTrackViews();
                if (autoWizard)
                    return p.then(function() {
                        return wizard(wizardOpts);
                    });
                return p.then(function() {
                    ez.modal();
                });
            }

            // Wait for one (or more) to finish
            var active = [];
            for (i = 0; i < threads; i++) {
                if (downloaders[i] !== null)
                    active.push(downloaders[i]);
            }

            return Promise.race(active).then(function(i) {
                downloaders[i] = null;
                multiModal(i, ".");
            }).then(mainLoop);
        }

        return mainLoop().catch(reportError);
    }

    // Perform a single download
    function doDownload(thread, trackNo) {
        trackNo = tracks[trackNo];

        var sock = new WebSocket("wss://" + url.host + "/panel/rec/ws");
        sock.binaryType = "arraybuffer";

        // First we need to send our login and get an ack
        return new Promise(function(res, rej) {
            sock.onopen = res;
            sock.onerror = function(err) {
                rej(new Error(err));
            };

        }).then(function() {
            // Send our login and anticipate acknowledgement
            var loginbuf = new DataView(new ArrayBuffer(16));
            loginbuf.setUint32(0, 0x11, true);
            loginbuf.setUint32(4, id, true);
            loginbuf.setUint32(8, key, true);
            loginbuf.setInt32(12, trackNo, true);
            sock.send(loginbuf.buffer);

            return new Promise(function(res, rej) {
                sock.onmessage = res;
                sock.onclose = sock.onerror = function(err) {
                    rej(new Error(err));
                };
            });

        }).then(function(msg) {
            msg = new DataView(msg.data);
            if (msg.getUint32(0, true) !== 0 ||
                msg.getUint32(4, true) !== 0x11) {
                sock.close();
                throw new Error(l("invalid"));
            }

            // Now we're into normal message mode
            return connection(sock, thread, trackNo);

        }).catch(reportError);
    }

    // The main loop for a single download
    function connection(sock, thread, trackNo) {
        var la;

        // A buffer of received but not yet acknowledged messages
        var msgbuf = [];

        // The message we're expecting
        var expecting = 0;

        // Are we currently handling messages?
        var handling = false;

        // Is the stream over?
        var eos = false;

        // Handler to send a packet (or null for EOF) to Ennuizel
        var packet = null;

        /* This whole function returns a promise which will resolve after it's
         * done, so get the resolution here */
        var res, rej;
        var promise = new Promise(function(pres, prej) {
            res = pres;
            rej = prej;
        });

        /* Our message receiver fills up the message buffer and starts the
         * handler */
        sock.onmessage = function(msg) {
            if (error) return;
            msg = new Uint8Array(msg.data);
            msgbuf.push(msg);

            if (!handling)
                handle();
        };

        // When we're closed, we're done
        sock.onclose = function() {
            eos = true;
            if (!handling)
                handle();
        };

        // If there's an error, die
        sock.onerror = function(err) {
            reportError(new Error(err));
            rej(err);
        };

        // Start our new track and we're done for now
        var name;
        if (trackNo in info.tracks) {
            name = trackNo + "-" + info.tracks[trackNo].nick;
        } else {
            name = trackNo + "";
        }
        newTrack();
        return promise;

        // Find a suitable next message and ack it
        function getNext() {
            while (msgbuf.length) {
                var msg = msgbuf.shift();
                var seq = new DataView(msg.buffer).getUint32(0, true);
                if (seq !== expecting) continue;
                expecting++;
                msg = msg.subarray(4);
                var ackbuf = new DataView(new ArrayBuffer(8));
                ackbuf.setUint32(0, 0, true);
                ackbuf.setUint32(4, seq, true);
                try {
                    sock.send(ackbuf.buffer);
                } catch (ex) {}
                return msg;
            }
            return null;
        }

        // Data handler
        function handle() {
            handling = true;

            // Get a message from the queue and acknowledge it
            var msg = getNext();

            // Perhaps we're done?
            if (msg === null) {
                if (eos) {
                    // We're done!
                    return packet(null).then(function() {
                        res(thread);
                        /* If we're not rendering, it's safe to show the tracks
                         * in multithreaded mode */
                         if (ez.skipRendering)
                             ez.updateTrackViews();
                    }).catch(rej);
                } else {
                    // Need more data
                    handling = false;
                    return;
                }
            }

            // Send this packet through
            return packet(msg).then(handle).catch(reportError);
        }

        // Create a new track
        function newTrack() {
            multiModal(thread, l("loadingx", name) + "...");

            var data = new Uint8Array(0);

            // Stage 1: Wait for enough data to start the LibAV part
            // Stage 2: Normal data
            // Stage 3: EOF
            var eof = false;

            var fmt_ctx, stream, c, pkt, frame;

            // Packet handler for before we've started LibAV
            packet = function(chunk) {
                if (chunk !== null) {
                    var c = new Uint8Array(data.length + chunk.length);
                    c.set(data, 0);
                    c.set(chunk, data.length);
                    data = c;
                } else
                    eof = true;

                // Collect data until we have 1MB or EOF
                if (data.length >= 1024*1024 || eof) {
                    // Now it's time to start libav. First make the device.
                    return LibAV.LibAV().then(function(ret) {
                        la = ret;
                        return la.mkreaderdev("dev.ogg");

                    }).then(function() {
                        return la.ff_reader_dev_send("dev.ogg", data);

                    }).then(function() {
                        if (eof)
                            return la.ff_reader_dev_send("dev.ogg", null);

                    }).then(function() {
                        return la.ff_init_demuxer_file("dev.ogg");

                    }).then(function(ret) {
                        fmt_ctx = ret[0];
                        stream = ret[1][0];
                        return la.ff_init_decoder(stream.codec_id);

                    }).then(function(ret) {
                        c = ret[1];
                        pkt = ret[2];
                        frame = ret[3];

                        return trackData(eof, fmt_ctx, [0], [0], [c], [pkt], [frame]);
                    }).catch(reportError);
                } else {
                    return Promise.all([]);
                }
            };
        }

        // Normal track data handler
        function trackData(eof, fmt_ctx, idxs, durations, cs, pkts, frameptrs) {
            /* We need to create an intricate interaction between two promise
             * chains: The actual importing will call back either with 'again', or,
             * upon EOF, by finishing, while the downloader has its own stream of
             * events to create the data. */
            var data = new Uint8Array(0);

            var importPromise = ez.importTrackLibAV(
                name, fmt_ctx, idxs, durations, cs, pkts, frameptrs,
                {
                    libav: la,
                    report: function(x) { return multiModal(thread, x); },
                    devfile: "dev.ogg",
                    againCb: againCb,
                    filter: "aresample=flags=res:min_comp=0.001:max_soft_comp=1000000:min_hard_comp=16:first_pts=0",
                    ignoreErrors: true
                }).then(function() {
                // Clean up
                return Promise.all([
                    la.ff_free_decoder(cs[0], pkts[0], frameptrs[0]),
                    la.avformat_close_input_js(fmt_ctx),
                    la.unlink("dev.ogg")
                ]);
            }).catch(reportError);

            var againRes, downPromise, downRes;

            downPromise = new Promise(function(res, rej) {
                downRes = res;
            });

            function againCb() {
                // Prepare to wait for more download
                var ret = new Promise(function(res, rej) {
                    againRes = res;
                });

                // And ask for it
                downRes();

                return ret;
            }

            packet = function(chunk) {
                // Append it
                if (chunk !== null) {
                    var c = new Uint8Array(data.length + chunk.length);
                    c.set(data, 0);
                    c.set(chunk, data.length);
                    data = c;

                    // Send it when we have a big chunk
                    if (data.length < 1024*1024)
                        return Promise.all([]);
                }

                // Send the data we have
                var p = la.ff_reader_dev_send("dev.ogg", data).then(function() {
                    data = new Uint8Array(0);
                    if (chunk === null)
                        return la.ff_reader_dev_send("dev.ogg", null);

                }).then(function() {
                    // Tell them we have more
                    var waiter = new Promise(function(res, rej) {
                        downRes = res;
                    });
                    againRes();
                    sent = 0;
                    return waiter;

                });

                if (chunk === null) {
                    // EOF
                    return importPromise;
                } else {
                    return p;
                }
            };

            if (eof) {
                return importPromise;
            } else {
                return downPromise;
            }
        }
    }

    // A function to handle making the modal dialog display multiple messages at once
    var modalMsgs = [];
    function multiModal(idx, msg) {
        while (modalMsgs.length <= idx)
            modalMsgs.push(".");
        modalMsgs[idx] = msg;
        ez.modal(modalMsgs.join("\n\n"));
    }

    // Get an export format based on a codec name
    function getExportFormat(codec) {
        for (var i = 0; i < ez.exportFormats.length; i++) {
            var format = ez.exportFormats[i];
            if (format.codec === codec)
                return format;
        }
        return ez.exportFormats[0];
    }

    // Add our wizard to the menu
    function wizardAdd() {
        ez.menu.push({
            name: l("wizard"),
            on: wizardMode
        });
        ez.showMenu();
    }

    // Convert wizard options from the URL fields into a displayable state
    function wizardConvertOpts() {
        if (wizardOpts === null)
            wizardOpts = 0;
        if (typeof wizardOpts === "object")
            return;

        var inOpts = wizardOpts;
        wizardOpts = {
            format: inOpts & 0xF,
            mix: !!(inOpts & 0x10),
            level: !!(inOpts & 0x20),
            noiser: !!(inOpts & 0x40),
            keep: !!(inOpts & 0x100),
            ask: !!(inOpts & 0x200)
        };
    }

    // Our wizard mode
    function wizardMode() {
        return wizardDialog().then(function(opts) {
            if (opts)
                return wizard(opts);
        });
    }

    // The wizard dialog, without the actual wizard
    function wizardDialog() {
        // Get our default options into a displayable state
        wizardConvertOpts();

        return ez.modalWait().then(function(unlock) {
            // Display the menu
            ez.modalDialog.innerHTML = "";

            var form = ez.mke(ez.modalDialog, "div", {"class": "modalform"});

            ez.mke(form, "label", {text: l("format") + ":", "class": "inputlabel", "for": "format"});
            var fmtSelect = ez.mke(form, "select", {id: "format"});
            for (var i = 0; i < formats.length; i++) {
                var format = getExportFormat(formats[i]);
                var opt = ez.mke(fmtSelect, "option", {text: format.name});
                opt.value = i;
                if (wizardOpts.format === i)
                    opt.selected = true;
            }

            ez.mke(form, "div", {text: "\n\n"});

            var mix = ez.mke(form, "input", {id: "mix"});
            mix.type = "checkbox";
            mix.checked = wizardOpts.mix;
            ez.mke(form, "label", {text: " " + l("domix"), "for": "mix"});
            ez.mke(form, "br");

            var level = ez.mke(form, "input", {id: "level"});
            level.type = "checkbox";
            level.checked = wizardOpts.level;
            ez.mke(form, "label", {text: " " + l("dolevel"), "for": "level"});
            ez.mke(form, "br");

            var noiser = ez.mke(form, "input", {id: "noiser"});
            noiser.type = "checkbox";
            noiser.checked = wizardOpts.noiser;
            ez.mke(form, "label", {text: " Noise reduction", "for": "noiser"});
            ez.mke(form, "br");

            var keep = ez.mke(form, "input", {id: "keep"});
            keep.type = "checkbox";
            keep.checked = wizardOpts.keep;
            ez.mke(form, "label", {text: " " + l("dokeep"), "for": "keep"});

            ez.mke(ez.modalDialog, "div", {text: "\n\n"});

            var cancel = ez.mke(ez.modalDialog, "button", {text: l("cancel")});
            ez.mke(ez.modalDialog, "span", {text: "  "});
            var ok = ez.mke(ez.modalDialog, "button", {text: l("go")});

            ez.modalToggle(true);
            ok.focus();

            return new Promise(function(res, rej) {
                cancel.onclick = function() {
                    unlock();
                    res(null);
                };
                ok.onclick = function() {
                    unlock();
                    // Gather our options
                    res({
                        format: fmtSelect.value,
                        mix: mix.checked,
                        level: level.checked,
                        noiser: noiser.checked,
                        keep: keep.checked
                    });
                };
            });

        }).then(function(opts) {
            ez.modal();
            return opts;
        });
    }

    // The actual wizard proper
    function wizard(opts) {
        var p = Promise.all([]);

        // Make sure we haven't been asked to do something nonsensical
        if (ez.nonemptyTracks(ez.selectedTracks()).length === 0) {
            ez.modal(l("empty"));
            return ez.deleteProject();
        }

        if (opts.noiser) {
            // Noise reduction
            p = p.then(function() {
                return ez.applyNoiseRepellentFilter({WHITENING: 25, adaptive: false});
            });
        }

        if (opts.mix) {
            // Mix
            p = p.then(function() {
                if (opts.level)
                    return ez.mix({fin: "dynaudnorm", fout: "dynaudnorm", keep: true});
                else
                    return ez.mix({keep: true});
            }).then(function(mix) {
                ez.selectNone();
                ez.selectTrack(mix.id, true);

            });

        } else if (opts.level) {
            // We need to level but didn't mix
            p = p.then(function() {
                return ez.applyLibAVFilter({params: [{}]}, ["dynaudnorm"]);
            });

        }

        // Now do the actual export
        p = p.then(function() {
            var format = getExportFormat(formats[opts.format]);
            return ez.exportProject(projName, format);

        });

        // Then possibly delete the project
        if (!opts.keep)
            p = p.then(ez.deleteProject);

        // Finally, tell them we're done
        p = p.then(function() {
            var msg = l("done");
            if (opts.keep)
                return ez.warn(msg);
            else
                ez.modal(msg);
        });

        return p;
    }

    return ez;
})(typeof Ennuizel === "object" ? Ennuizel : {});
