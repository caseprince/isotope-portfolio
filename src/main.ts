import $ from "jquery";
import Isotope from "isotope-layout";
import Packery from "packery";
import getSize from "get-size";

// These are ancient jQuery plugins that don't support ESM, so we have to do some manual registration
import registerTyper from "./jquery/jquery.typer";
import registerFancyBox from "./jquery/jquery.fancybox.js";

registerTyper($);
registerFancyBox(window, document, $);

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
$.each(content, function () {
    const id = $(this).attr("id"),
        w = $(this).data("w") || 1,
        h = $(this).data("h") || 1,
        title = $(this).find("h2")[0]?.innerHTML,
        style = w == 1 ? "font-size:.7em;" : "",
        href = $(this).data("href"),
        externalLink = !$(this).hasClass("fancybox") && $(this).data("href"),
        imageUrl = $(this).find("a")[0]?.getAttribute("href");

    var classes = "";
    if ($(this).hasClass("fancybox")) {
        classes += "fancybox ";
    }
    if ($(this).hasClass("iframe")) {
        classes += "iframe ";
    }

    const html = `
    <a style="${style}" class="${classes}element w-${w} h-${h}" data-id="${id}" ${
        href ? `data-href="${href}"` : ""
    } ${externalLink ? `href="${externalLink}"` : ""}>
        <div style="background-image: url('${imageUrl}')">
            <h4>${title}</h4>
            ${
                externalLink
                    ? `<span class="external-link">${externalLink}</span>`
                    : ""
            }
        </div>
    </a>
    `;

    $("#container").append(html);
});

// Centers packery layout
var __resetLayout = Packery.prototype._resetLayout;
Packery.prototype._resetLayout = function () {
    __resetLayout.call(this);
    var parentSize = getSize(this.element.parentNode);
    var colW = this.columnWidth + this.gutter;
    this.fitWidth =
        Math.floor((parentSize.innerWidth + this.gutter) / colW) * colW;
    this.packer.width = this.fitWidth;
    this.packer.height = Number.POSITIVE_INFINITY;
    this.packer.reset();
};

Packery.prototype._getContainerSize = function () {
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

$(".element").click(function () {
    if (!$(this).hasClass("fancybox") && $(this).data("href")) {
        window.location.assign($(this).data("href"));
        return;
    }
    var id = $(this).data("id");
    window.location.hash = "#" + id;
});

$("#scrim, #overlay, .close").click(function (e) {
    console.log(e.target);
    if (
        e.target.id === "scrim" ||
        e.target.id === "overlay" ||
        e.target.classList.contains("close")
    ) {
        clearHash();
    }
});

function clearHash() {
    var scrollY = window.scrollY;
    var scrollX = window.scrollX;

    window.location.hash = "";

    $("#overlay, #scrim").hide();
    $("body").removeAttr("style");

    window.scrollTo(scrollX, scrollY);
}

function updateHash() {
    var id = window.location.hash;
    if (id) {
        id = id.slice(1);
        var $content = $("#" + id),
            $thumb = $('*[data-id="' + id + '"]');
        if ($('*[data-id="' + id + '"]').hasClass("fancybox")) {
            $.fancybox({
                title: $content.data("caption") || "",
                href: $content.data("href"),
                type: $thumb.hasClass("iframe") ? "iframe" : "image",
                afterClose: function () {
                    clearHash();
                },
                openSpeed: 0,
                closeSpeed: 0,
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
                "margin-right": 0,
            });
        }
    } else {
        if ($.fancybox && $.fancybox.close) {
            $.fancybox.close(true);
        }
    }
}
window.onhashchange = updateHash;
updateHash();

if (!/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)) {
    if ($.stellar) {
        $.stellar({
            horizontalScrolling: false,
        });
    }
}

$(".thumb, .fancythumb").fancybox({
    openSpeed: 0,
    closeSpeed: 0,
    helpers: {
        overlay: {
            speedOut: 0,
        },
    },
});
$("a.mh").fancybox({ width: 760 });

$.typer.options.typerInterval = 7500;
$.typer.options.typeDelay = 30;
$("[data-typer-targets]").typer();

$("#brands, footer").delay(1000).show();
