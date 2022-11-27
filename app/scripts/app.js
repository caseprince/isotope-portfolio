define([
    "jquery",
    "isotope",
    "packery",
    "get-size",

    //jquery plugins
    "typer",
    "stellar",
    "fancybox",

    //'packery-layout',
], function ($, Isotope, Packery, getSize) {
    console.log("jQuery %s", $().jquery);
    console.log("isotope", Isotope);
    console.log("Packery", Packery);

    // Create the measurement node
    var scrollDiv = document.createElement("div");
    scrollDiv.className = "scrollbar-measure";
    document.body.appendChild(scrollDiv);

    // Get the scrollbar width
    var scrollbarWidth = scrollDiv.offsetWidth - scrollDiv.clientWidth;

    // Delete the DIV
    document.body.removeChild(scrollDiv);

    var content = $("#content > div");
    $.each(content, function (index, item) {
        var w = $(this).attr("data-w") || 1,
            h = $(this).attr("data-h") || 1,
            title = $(this).find("h2")[0].innerHTML,
            style = w == 1 ? "font-size:.7em;" : "";

        classes = "";
        if ($(this).hasClass("fancybox")) {
            classes += "fancybox ";
        }
        if ($(this).hasClass("iframe")) {
            classes += "iframe ";
        }

        var imageUrl = $(this).find("a")[0].getAttribute("href"),
            html =
                '<div style="' +
                style +
                '" class="' +
                classes +
                "element w-" +
                w +
                " h-" +
                h +
                '" data-id="' +
                $(this).attr("id");
        if ($(this).data("href")) {
            html += '" data-href="' + $(this).data("href");
        }
        html += '">';
        html += "<div style=\"background-image: url('" + imageUrl + "')\">";
        html += "<h4>" + title + "</h4></div></div>";

        $("#container").append(html);
    });

    // overwrite Packery methods
    var __resetLayout = Packery.prototype._resetLayout;
    Packery.prototype._resetLayout = function () {
        __resetLayout.call(this);
        // reset packer
        var parentSize = getSize(this.element.parentNode);
        var colW = this.columnWidth + this.gutter;
        this.fitWidth =
            Math.floor((parentSize.innerWidth + this.gutter) / colW) * colW;
        //console.log( colW, this.fitWidth )
        this.packer.width = this.fitWidth;
        this.packer.height = Number.POSITIVE_INFINITY;
        this.packer.reset();
    };

    Packery.prototype._getContainerSize = function () {
        // remove empty space from fit width
        var emptyWidth = 0;
        for (var i = 0, len = this.packer.spaces.length; i < len; i++) {
            var space = this.packer.spaces[i];
            if (space.y === 0 && space.height === Number.POSITIVE_INFINITY) {
                emptyWidth += space.width;
            }
        }
        return {
            width: this.fitWidth - this.gutter,
            height: this.maxY - this.gutter,
        };
    };

    // always resize
    Packery.prototype.resize = function () {
        this.layout();
    };

    var container = document.querySelector("#container");
    var pckry = new Packery(container, {
        itemSelector: ".element",
        columnWidth: 120,
        gutter: 10,
    });

    $(".element").click(function (event) {
        if (!$(this).hasClass("fancybox") && $(this).data("href")) {
            window.location.assign($(this).data("href"));
            return;
        }
        var id = $(this).data("id");
        window.location.hash = "#" + id;
    });

    $("#scrim, #overlay, .close").click(clearHash);

    function clearHash() {
        // Prevent scrolling by storing the page's current scroll offset
        var scrollY = window.scrollY;
        var scrollX = window.scrollX;

        window.location.hash = "";

        $("#overlay, #scrim").hide();
        $("body").removeAttr("style");
        // Restore the scroll offset, should be flicker free
        window.scrollTo(scrollX, scrollY);
    }

    function updateHash() {
        var id = window.location.hash;
        if (id) {
            id = id.slice(1);
            var $content = $("#" + id),
                $thumb = $('*[data-id="' + id + '"]');
            if ($('*[data-id="' + id + '"]').hasClass("fancybox")) {
                // https://web.archive.org/web/20210320162609/http://fancyapps.com/fancybox/#docs
                $.fancybox({
                    title: $content.data("caption") || "",
                    href: $content.data("href"),
                    type: $thumb.hasClass("iframe") ? "iframe" : "image",
                    afterClose: function () {
                        clearHash();
                    },
                    openSpeed: 0,
                    closeSpeed: 0,
                    scrolling: "visible",
                    helpers: {
                        overlay: {
                            speedOut: 0,
                        },
                    },
                });
            } else {
                $("#content > div").hide(0);
                $content.show(0);
                $("#overlay, #scrim").fadeIn(50);
                $("#overlay").scrollTop(0);
                $("body").css({
                    overflow: "hidden",
                    "margin-right": scrollbarWidth + "px",
                });
            }
        } else {
            // $("#overlay, #scrim").hide();
            // $("body").removeAttr("style");
            $.fancybox.close(true);
        }
    }
    window.onhashchange = updateHash;
    updateHash();

    if (
        !/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)
    ) {
        $.stellar({
            horizontalScrolling: false,
        });
    }

    $(".thumb, .fancythumb").fancybox();
    $("a.mh").fancybox({ width: 760 });
    $("#hbo_vis").fancybox({ width: 307, height: 390 });
    $("#espn_nba").fancybox({ width: 970, height: 250 });

    $.typer.options.typerInterval = 7500;
    ($.typer.options.typeDelay = 50), $("[data-typer-targets]").typer();

    $("#brands, footer").delay(1000).show();
});
