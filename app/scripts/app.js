define(
	[
		'jquery',
		'isotope',
		'packery',
		'get-size',

		//jquery plugins
		'typed',
		'stellar',
		'fancybox'

		//'packery-layout',
	], 

	function($, Isotope, Packery, getSize) {
		console.log('jQuery %s', $().jquery);
		console.log('isotope', Isotope);
		console.log('Packery', Packery);

		var content = $('#content > div');
		$.each(content, function (index, item) {

		  var w = 1;
		  if($(this).attr("data-w")){
		  	w = $(this).attr("data-w");
		  }
		  var h = 1;
		  if($(this).attr("data-h")){
		  	h = $(this).attr("data-h");
		  }

		  //var img = $(this).find('a')[0].attr("href");
		  var imageUrl =  $(this).find('a')[0].getAttribute('href');
		 // window.console.log(imageUrl);

		  var title = $(this).find('h2')[0].innerHTML;

		  var style = "";
		  if(w == 1){
		  	style += 'font-size:.7em;';
		  }
		  classes = ""
		  if($(this).hasClass('fancybox')){
		  	classes += 'fancybox ';
		  }
		  if($(this).hasClass('iframe')){
		  	classes += 'iframe ';
		  }


		  var html = '<div style="'+style+'" class="'+classes+'element w-'+w+' h-'+h+'" data-id="'+$(this).attr("id")+'">';
		      html += '<div style="background-image: url(\''+imageUrl+'\')">';
		      html += '<h4>'+title+'</h4></div></div>';
			
			$("#container").append(html);


		});


		// overwrite Packery methods
		var __resetLayout = Packery.prototype._resetLayout;
		Packery.prototype._resetLayout = function() {
		  __resetLayout.call( this );
		  // reset packer
		  var parentSize = getSize( this.element.parentNode );
		  var colW = this.columnWidth + this.gutter;
		  this.fitWidth = Math.floor( ( parentSize.innerWidth + this.gutter ) / colW ) * colW;
		  console.log( colW, this.fitWidth )
		  this.packer.width = this.fitWidth;
		  this.packer.height = Number.POSITIVE_INFINITY;
		  this.packer.reset();
		};


		Packery.prototype._getContainerSize = function() {
		  // remove empty space from fit width
		  var emptyWidth = 0;
		  for ( var i=0, len = this.packer.spaces.length; i < len; i++ ) {
		    var space = this.packer.spaces[i];
		    if ( space.y === 0 && space.height === Number.POSITIVE_INFINITY ) {
		      emptyWidth += space.width;
		    }
		  }

		  return {
		    width: this.fitWidth - this.gutter,
		    height: this.maxY - this.gutter
		  };
		};

		// always resize
		Packery.prototype.resize = function() {
		  this.layout();
		};

		 var container = document.querySelector('#container');
		  var pckry = new Packery( container, {
		    itemSelector: '.element',
		    columnWidth: 120,
		    gutter: 10
		  });


		/*var container = $('#container')[0];
		var iso = window.iso = new Isotope( container, {
			//layoutMode: 'fitRows',
			//masonry: {
			//      columnWidth: 50
			//    },
			layoutMode: 'packery',
			packery: {
			  gutter: 10
			},
			//itemSelector: '.mini-item',
			//stamp: '.stamp'
			getSortData: {
				  // number: function( itemElem ) {
				  //   return parseInt( getText( itemElem.querySelector('.number') ), 10 );
				  // },
				  // symbol: function( itemElem ) {
				  //   return getText( itemElem.querySelector('.symbol') );
				  // },
				  // name: function( itemElem ) {
				  //   return getText( itemElem.querySelector('.name') );
				  // },
				  // category: function( itemElem ) {
				  //   return itemElem.getAttribute('data-category');
				  // },			  
				  number: '.number parseInt',
				  symbol: '.symbol',
				  name: '.name',
				  category: '[data-category]'			  
			  }
		});*/

		//var options = document.querySelector('#options');


		/*$('#options li a').click(function(event){
			//});
			//eventie.bind( options, 'click', function( event ) {
			// use link's href, remove leading hash
			var sortBy = event.target.getAttribute('href').slice( 1 );
			sortBy.slice( 0, 1 );
			iso.options.sortBy = sortBy;
			//window.console.log(iso, sortBy, event.target.getAttribute('href'));
			iso.arrange();
			event.preventDefault();
		});

		function getText( elem ) {
		  return elem.textContent || elem.innerText;
		}*/

		$(".element").click(function(event){
			window.console.log();
			var id = $(this).data("id");

			if($(this).hasClass("fancybox")){

				href = $("#"+id).data("href");
				type = 'image';
				if($(this).hasClass("iframe")){
					type = 'iframe'
				}

				$.fancybox({
				//'padding'		: 0,
				//'autoScale'		: false,
				//'transitionIn'	: 'none',
				//'transitionOut'	: 'none',
				//'title'			: this.title,
				//'width'		: 680,
				//'height'		: 495,
				'href'			: href,
				'type'			: type
				//'type'			: 'swf',
				//'swf'			: {
				   	// 'wmode'		: 'transparent',
					//'allowfullscreen'	: 'true'
				//}
		});
			}else{
				$("#content > div").hide(0);
				$("#content > div#"+id).show(0);
				$("#overlay").fadeIn(100);
			}
			

		});

		$("#scrim, #overlay .close").click(function(){
			$("#overlay").fadeOut(100);
			
		})

		$("#overlay #content").click(function(event){
			//event.preventDefault();
			//event.stopPropigation();
		});


		if( !/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent) ) {
			$.stellar({
				horizontalScrolling: false
			});
		}


		$(".thumb").fancybox({
		  beforeShow : function(){
		   //this.title =  this.title + " - " + $(this.element).data("caption") + '<a href="#">foo</a>' + '<br><br><br> <br><br><br> foooo';
		  }
		 });

		$("a.mh").fancybox({'width':760});
		$("#hbo_vis").fancybox({'width':307, height:390});
		$("#espn_nba").fancybox({'width':970, height:250});
		

	    $("#typed").typed({
			strings: [
				"paper airplanes.", 
				"origami",
				"cat toys",
				"cat videos",
				"LED light fixtures",
				"LED bonsais",
				"timelapse videos",
				"experiences",
				"brands",
				"things."
			],
			typeSpeed: 50
	    });

	    $("#brands, footer").delay(1000).show();



	}
);