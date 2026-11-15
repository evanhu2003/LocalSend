import 'package:flutter/material.dart';

class SizingInformation {
  final bool isMobile;
  final bool isTabletOrDesktop;
  final bool isDesktop;

  const SizingInformation(double width) : isMobile = width < 700, isTabletOrDesktop = width >= 700, isDesktop = width >= 800;

  /// Tiny screens such as square smartwatches (e.g. a 326x400 dp Unisoc W527 watch).
  /// Phones are excluded: even small phones are at least ~480 dp on the long side.
  static bool isCompactScreen(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return size.shortestSide < 360 && size.longestSide < 480;
  }
}

class ResponsiveBuilder extends StatelessWidget {
  final Widget Function(SizingInformation sizingInformation) builder;

  const ResponsiveBuilder({required this.builder});

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return builder(SizingInformation(width));
  }
}
